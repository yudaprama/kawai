import { Icon } from "@/components/shared/icon";
import { useCallback, useEffect, useRef, useState } from "react";
import { createApp, nextTick, onMounted, reactive, ref, watch } from "vue/dist/vue.esm-bundler.js";
import MarkdownIt from "markdown-it";

import { Button } from "@/components/ui/button";
import { call, errText, tauriOpenFile } from "@/lib/api";
import { runningInTauri } from "@/platform";

/**
 * Deck preview — markdown slide runtime (Slidev model) as a Vue island
 * inside the React canvas.
 *
 * `office_read_deck` returns the deck body as Slidev-style markdown
 * (`layout:` frontmatter + fields, `##`/`#` headings, bullets, tables,
 * `::right::`/column comments) — the runtime compiles it with markdown-it
 * and renders ONE slide at a time inside a 16:9 frame that tracks the
 * column width, with PowerPoint-style shrink-to-fit when a slide is dense.
 * No iframe, no scrolling, no measurement-based frame fitting.
 *
 * **Present** shows the same runtime fullscreen in the app (Esc exits).
 */

interface ReadDeckResult {
  title?: string | null;
  template?: string | null;
  themeCss?: string;
  markdown?: string;
}

const RUNTIME_CSS = `.deckmd-runtime{--slidev-primary:#3ab9d5;
  background:#fff;color:#1a202c;
  font-family:Poppins,ui-sans-serif,-apple-system,'Segoe UI',sans-serif;
  padding:40px 52px;overflow:hidden;height:100%;box-sizing:border-box;
  display:flex;flex-direction:column;justify-content:center}
.deckmd-runtime .deck-fit{margin:0;width:100%}
.deckmd-runtime h1{font-size:2.2em;line-height:1.2;font-weight:600;margin:0 0 20px;letter-spacing:-.02em}
.deckmd-runtime h2{font-size:1.7em;line-height:1.25;font-weight:600;margin:0 0 18px;letter-spacing:-.02em;color:#4a5568}
.deckmd-runtime h3{font-size:1.15em;font-weight:600;margin:16px 0 8px}
.deckmd-runtime p{font-size:1.05em;line-height:1.7;margin:0 0 12px;color:#4a5568}
.deckmd-runtime ul{padding-left:1.2em;margin:8px 0;list-style-type:disc}
.deckmd-runtime li{font-size:1.08em;line-height:1.95;color:#2d3748}
.deckmd-runtime li::marker{color:var(--slidev-primary)}
.deckmd-runtime strong{color:var(--slidev-primary);font-weight:600}
.deckmd-runtime blockquote{border-left:4px solid var(--slidev-primary);margin:16px 0;padding:4px 18px;font-style:italic;color:#2d3748}
.deckmd-runtime table{border-collapse:collapse;font-size:.95em;margin:10px 0;width:100%}
.deckmd-runtime th,.deckmd-runtime td{border-bottom:1px solid #e2e8f0;padding:8px 12px;text-align:left}
.deckmd-runtime th{color:var(--slidev-primary);font-weight:600}
.deckmd-runtime .kicker{display:inline-block;font-size:.75em;font-weight:700;letter-spacing:.14em;color:var(--slidev-primary);text-transform:uppercase;margin-bottom:14px}
.deckmd-runtime .lede{font-size:1.3em;line-height:1.45;color:#1a202c}
.deckmd-runtime .big-number{display:block;font-size:110px;font-weight:800;line-height:1.05;color:var(--slidev-primary);margin-bottom:10px}
.deckmd-runtime .divider-accent{width:64px;height:3px;background:var(--slidev-primary);border-radius:2px;margin:18px 0}
.deckmd-runtime .grid{display:grid;gap:16px;margin-top:8px}
.deckmd-runtime .grid.g2{grid-template-columns:1fr 1fr}
.deckmd-runtime .grid.g3{grid-template-columns:1fr 1fr 1fr}
.deckmd-runtime .card{background:#f8fafb;border:1px solid #e2e8f0;border-radius:10px;padding:18px 20px}
.deckmd-runtime .card h3{margin-top:0}
.deckmd-runtime .card p{font-size:.95em;margin:6px 0 0}
.deckmd-runtime .deck-nav{display:flex;align-items:center;justify-content:center;gap:16px;
  font:12px monospace;color:#a0aec0;margin-top:auto;padding-top:12px}
.deckmd-runtime .deck-nav button{cursor:pointer;background:none;border:none;font-size:16px;color:inherit}
.deckmd-runtime .deck-nav button:disabled{opacity:.4;cursor:default}`;

/** Inline markdown → HTML: escape first, then convert bold / italic / code
 *  markers via a zero-preset markdown-it — no raw markup passes through. */
const mdInline = new MarkdownIt("zero", { linkify: false }).enable(["emphasis", "backticks"]);

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inline(s: string): string {
  return mdInline.renderInline(s);
}

interface V2Slide {
  layout: string;
  fm: Record<string, string>;
  html: string;
  title: string;
}

/** Content lines → v2 pieces (mirrors the Rust parser's content model). */
function contentPieces(content: string) {
  const items: string[] = [];
  const left: string[] = [];
  const right: string[] = [];
  const quote: string[] = [];
  const paragraphs: string[] = [];
  let headers: string[] | null = null;
  const rows: string[][] = [];
  let inRight = false;
  let sawColumns = false;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (t.length === 0) continue;
    if (t === "::right::") {
      if (left.length === 0) left.push(...items.splice(0));
      inRight = true;
      continue;
    }
    if (t.startsWith("<!--") && t.endsWith("-->")) {
      const cmd = t.slice(4, -3).trim();
      if (cmd.startsWith("column:")) {
        if (left.length === 0) left.push(...items.splice(0));
        inRight = cmd.slice(7).trim() !== "0";
        sawColumns = true;
      }
      continue;
    }
    const bullet = t.startsWith("- ") || t.startsWith("* ") ? t.slice(2).trim() : null;
    if (bullet != null) {
      (inRight ? right : items).push(bullet);
      continue;
    }
    if (t.startsWith("> ")) {
      quote.push(t.slice(2).trim());
      continue;
    }
    if (t.startsWith("|")) {
      const cells = t
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      if (cells.every((c) => /^[-: ]+$/.test(c))) continue;
      if (headers == null) headers = cells;
      else rows.push(cells);
      continue;
    }
    if (inRight) right.push(t);
    else paragraphs.push(t);
  }
  return { items, left, right, quote, paragraphs, headers, rows, inRight, sawColumns };
}

/** One markdown chunk → one v2 slide rendered as HTML (mirrors the Rust
 *  `DeckSlideV2::body_html` templates). */
function renderSlide(chunk: string, isFirst: boolean): V2Slide {
  const lines = chunk.split("\n");
  const fm: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = lines[i].trim().match(/^([a-zA-Z][a-zA-Z0-9]*):\s*(.*)$/);
    if (m == null) break;
    fm[m[1].toLowerCase()] = m[2].trim();
  }
  const content = lines.slice(i).join("\n");
  const pieces = contentPieces(content);
  const layout = (fm.layout ?? inferLayout(pieces, isFirst)).toLowerCase();
  const title = fm.title ?? pieces.paragraphs[0] ?? "";
  const card = (t: string | null, items: string[]) =>
    `<div class="card">${t != null ? `<h3>${inline(t)}</h3>` : ""}<ul>${items
      .map((it) => `<li>${inline(it)}</li>`)
      .join("")}</ul></div>`;

  // Layouts that render their own display title (title/section) skip the h2 —
  // every other layout shows the slide title above its content.
  const titleHtml = fm.title != null && fm.title.trim().length > 0 ? `<h2>${inline(fm.title)}</h2>` : "";

  let html: string;
  switch (layout) {
    case "title":
      html = `<div style="height:100%;display:flex;flex-direction:column;justify-content:center">
        ${fm.kicker != null ? `<span class="kicker">${esc(fm.kicker)}</span>` : ""}
        <p style="font-size:56px;font-weight:800;line-height:1.12;margin:0 0 16px">${inline(title)}</p>
        ${fm.subtitle != null ? `<p class="lede">${inline(fm.subtitle)}</p>` : ""}
        <div class="divider-accent"></div></div>`;
      break;
    case "section":
      html = `<div style="height:100%;display:flex;flex-direction:column;justify-content:center">
        ${fm.kicker != null ? `<span class="kicker">${esc(fm.kicker)}</span>` : ""}
        <p style="font-size:44px;font-weight:800;line-height:1.15;margin:0">${inline(title)}</p>
        <div class="divider-accent"></div></div>`;
      break;
    case "bullets":
      html =
        titleHtml +
        `<ul style="font-size:22px;line-height:1.85">${pieces.items
          .map((it) => `<li>${inline(it)}</li>`)
          .join("")}</ul>`;
      break;
    case "two-cols":
      html =
        titleHtml +
        `<div class="grid g2">${card(fm.leftTitle ?? null, pieces.left)}${card(
          fm.rightTitle ?? null,
          pieces.right,
        )}</div>`;
      break;
    case "fact":
      html =
        titleHtml +
        `<div style="height:100%;display:flex;flex-direction:column;justify-content:center;text-align:center">
        <span class="big-number">${inline(fm.big ?? "")}</span><p class="lede">${inline(fm.caption ?? "")}</p></div>`;
      break;
    case "quote":
      html =
        titleHtml +
        `<blockquote style="font-size:30px;line-height:1.5">${inline(fm.quote ?? pieces.quote.join(" "))}</blockquote>${
          fm.author != null ? `<p class="kicker">— ${esc(fm.author)}</p>` : ""
        }`;
      break;
    case "table": {
      const th = (fm.headers ?? pieces.headers?.join(",") ?? "")
        .split(",")
        .map((h) => h.trim())
        .filter(Boolean);
      const rows = pieces.rows.length > 0 ? pieces.rows : [];
      html =
        titleHtml +
        `<table><tr>${th.map((h) => `<th>${inline(h)}</th>`).join("")}</tr>${rows
          .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</table>`;
      break;
    }
    case "image":
      html =
        titleHtml +
        `<div style="height:100%;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:14px">
        <div style="border:1px dashed #cbd5e1;border-radius:12px;padding:40px 60px;color:#94a3b8">🖼 ${esc(fm.fileId ?? "")}</div>
        ${fm.caption != null ? `<p class="kicker">${esc(fm.caption)}</p>` : ""}</div>`;
      break;
    default:
      html = `<p class="lede">${inline(pieces.paragraphs.join(" "))}</p>`;
  }
  return { layout, fm, html, title };
}

function inferLayout(pieces: ReturnType<typeof contentPieces>, isFirst: boolean): string {
  if (pieces.sawColumns || pieces.right.length > 0) return "two-cols";
  if (pieces.quote.length > 0) return "quote";
  if (pieces.headers != null) return "table";
  if (pieces.items.length >= 2) return "bullets";
  if (isFirst) return "title";
  return "section";
}

/** Slidev/presenterm markdown → v2 slides (mirrors `parse_deck_markdown`). */
function parseDeckMarkdown(md: string): V2Slide[] {
  const chunks = md
    .split("\n---\n")
    .map((c) => c.replace(/^---\n/, "").trim())
    .filter(Boolean);
  return chunks.map((c, i) => renderSlide(c, i === 0));
}

/** Mount the slide runtime into `host`: markdown → parsed slides → one
 *  visible slide + nav, with PowerPoint-style shrink-to-fit (content taller
 *  than the frame scales down instead of scrolling). Returns the cleanup fn. */
function mountDeckRuntime(
  host: HTMLDivElement,
  markdown: string,
  opts: { fullscreen?: boolean; themeCss?: string } = {},
): () => void {
  const slides = parseDeckMarkdown(markdown);
  if (slides.length === 0) return () => {};
  const rendered = slides.map((sl) => sl.html);
  const state = reactive({ index: 0, total: slides.length });
  const go = (d: number) => {
    state.index = Math.min(slides.length - 1, Math.max(0, state.index + d));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
    else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    else if (opts.fullscreen === true && e.key === "Escape") host.dataset.exited = "1";
  };
  window.addEventListener("keydown", onKey);

  // Deck theme stylesheet (tokens + layout rules + fonts), extracted from
  // the stored deck. :root token blocks are retargeted to the preview's
  // .deck-scope wrapper so the app's own CSS is never touched; the runtime
  // CSS above acts only as the no-theme fallback (injected first, loses ties).
  if (opts.themeCss != null && opts.themeCss.trim().length > 0) {
    const styleEl = document.createElement("style");
    styleEl.setAttribute("data-deck-theme", "");
    styleEl.textContent = opts.themeCss.replace(/:root\s*{/g, ".deckmd-runtime .deck-scope{");
    host.appendChild(styleEl);
  }

  const app = createApp({
    setup(_, { expose }) {
      const fitRef = ref<HTMLDivElement | null>(null);
      const fit = () => {
        const el = fitRef.value;
        if (el == null) return;
        el.style.transform = "scale(1)";
        el.style.transformOrigin = "center center";
        const avail = host.clientHeight - 80; // runtime padding
        const natural = el.offsetHeight;
        if (avail > 0 && natural > 0) {
          el.style.transform = `scale(${Math.min(1, avail / natural)})`;
        }
      };
      watch(
        () => state.index,
        () => nextTick(fit),
      );
      onMounted(() => {
        nextTick(fit);
        if (fitRef.value != null) {
          const ro = new ResizeObserver(fit);
          ro.observe(fitRef.value);
        }
        document.fonts?.ready.then(fit).catch(() => {});
      });
      expose({ refit: fit });
      return { state, rendered, go, fitRef };
    },
    template: `
      <div class="deckmd-runtime">
        <div class="deck-fit" ref="fitRef">
          <!-- biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it with html:false over server-sanitized deck content -->
          <div v-html="rendered[state.index]"></div>
        </div>
        <div class="deck-nav">
          <button :disabled="state.index===0" @click="go(-1)">←</button>
          <span>{{ state.index + 1 }} / {{ state.total }}</span>
          <button :disabled="state.index===state.total-1" @click="go(1)">→</button>
        </div>
      </div>`,
  });
  app.mount(host);
  return () => {
    window.removeEventListener("keydown", onKey);
    app.unmount();
    host.querySelectorAll("style[data-deck-theme]").forEach((el) => {
      el.remove();
    });
  };
}

export function DeckPreview({ fileId }: { fileId: string }) {
  const [data, setData] = useState<ReadDeckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Present: fullscreen in-app (the runtime fills the viewport; Esc exits).
  const [presenting, setPresenting] = useState(false);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const presentRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    void call<ReadDeckResult>("office_read_deck", { fileId })
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(errText(e));
      });
    return () => {
      cancelled = true;
    };
  }, [fileId]);

  // ── Vue island: markdown runtime ──
  useEffect(() => {
    const host = hostRef.current;
    if (host == null || data?.markdown == null) return;
    return mountDeckRuntime(host, data.markdown, { themeCss: data.themeCss });
  }, [data]);

  // ── Present overlay: same runtime at full viewport ──
  useEffect(() => {
    const host = presentRef.current;
    if (!presenting || host == null || data?.markdown == null) return;
    const cleanup = mountDeckRuntime(host, data.markdown, {
      fullscreen: true,
      themeCss: data.themeCss,
    });
    return cleanup;
  }, [presenting, data]);

  const [pptxExported, setPptxExported] = useState<string | null>(null);
  const openPptxExport = useCallback(async () => {
    try {
      const f = await call<{ id: string; originalName: string }>("office_export_deck", { fileId });
      setPptxExported(f.originalName);
      // Desktop: open the exported .pptx in the OS default viewer. Web has
      // no opener op — the status text still points at Documents.
      if (runningInTauri) {
        void tauriOpenFile(f.id).catch((e) => setPptxExported(`ERROR: ${errText(e)}`));
      }
    } catch (e) {
      setPptxExported(`ERROR: ${errText(e)}`);
    }
  }, [fileId]);

  if (error != null) {
    return (
      <div className="text-muted-foreground flex items-center justify-center p-8 font-mono text-xs">
        Deck preview failed: {error}
      </div>
    );
  }
  if (data == null) {
    return (
      <div className="text-muted-foreground flex items-center justify-center p-8 font-mono text-xs">Loading deck…</div>
    );
  }

  return (
    <div className="space-y-2">
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: static runtime stylesheet */}
      <style dangerouslySetInnerHTML={{ __html: RUNTIME_CSS }} />
      {/* Markdown compiled by the embedded Vue runtime — deck content is
          sanitized server-side before storage; html:false in markdown-it
          keeps the rendering inert. */}
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-white">
        <div ref={hostRef} className="h-full w-full" />
      </div>
      <div className="flex items-center justify-center gap-2">
        <Button onClick={() => setPresenting(true)} size="sm" variant="outline">
          <Icon name="expand" className="size-3.5" /> Present
        </Button>
        <Button onClick={() => void openPptxExport()} size="sm" variant="outline">
          <Icon name="presentation" className="size-3.5" /> Export PPTX
        </Button>
        {pptxExported != null && (
          <span
            className={
              pptxExported.startsWith("ERROR")
                ? "text-destructive font-mono text-[11px]"
                : "text-success font-mono text-[11px]"
            }
          >
            {pptxExported.startsWith("ERROR")
              ? `PPTX export failed: ${pptxExported.slice(7)}`
              : `Saved as ${pptxExported} — view it in Documents`}
          </span>
        )}
      </div>
      {presenting && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black" ref={presentRef} />}
    </div>
  );
}
