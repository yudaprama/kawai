import { ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { createApp, reactive } from "vue/dist/vue.esm-bundler.js";
import MarkdownIt from "markdown-it";

import { Button } from "@/components/ui/button";
import { call, errText, tauriOpenFile } from "@/lib/api";

/**
 * Deck preview — markdown slide runtime (Slidev model) as a Vue island
 * inside the React canvas.
 *
 * `office_read_deck` returns the deck body as Slidev-style markdown
 * (`#` deck title, `##` per slide, blocks below) — the runtime compiles it
 * with markdown-it and renders ONE slide at a time inside a 16:9 frame that
 * tracks the column width. No iframe, no measurement, no fixed-size canvas:
 * the frame is by-construction exactly the container and content never
 * escapes it.
 *
 * Full-fidelity presentation (animations, keyboard nav) stays available via
 * "Open full deck" — the reveal.js file opens in the system browser.
 */

interface ReadDeckResult {
  title?: string | null;
  template?: string | null;
  markdown?: string;
}

const RUNTIME_CSS = `.deckmd-runtime{--slidev-primary:#3ab9d5;
  background:#fff;color:#1a202c;
  font-family:Poppins,ui-sans-serif,-apple-system,'Segoe UI',sans-serif;
  padding:40px 52px;overflow-y:auto;height:100%;box-sizing:border-box}
.deckmd-runtime h1{font-size:2.2em;line-height:1.2;font-weight:600;margin:0 0 20px;letter-spacing:-.02em}
.deckmd-runtime h2{font-size:1.7em;line-height:1.25;font-weight:600;margin:0 0 18px;letter-spacing:-.02em;color:#4a5568}
.deckmd-runtime h3{font-size:1.15em;font-weight:600;margin:16px 0 8px}
.deckmd-runtime p{font-size:1.05em;line-height:1.7;margin:0 0 12px;color:#4a5568}
.deckmd-runtime ul{padding-left:1.2em;margin:8px 0}
.deckmd-runtime li{font-size:1.08em;line-height:1.95;color:#2d3748}
.deckmd-runtime li::marker{color:var(--slidev-primary)}
.deckmd-runtime strong{color:var(--slidev-primary);font-weight:600}
.deckmd-runtime blockquote{border-left:4px solid var(--slidev-primary);margin:16px 0;padding:4px 18px;font-style:italic;color:#2d3748}
.deckmd-runtime table{border-collapse:collapse;font-size:.95em;margin:10px 0;width:100%}
.deckmd-runtime th,.deckmd-runtime td{border-bottom:1px solid #e2e8f0;padding:8px 12px;text-align:left}
.deckmd-runtime th{color:var(--slidev-primary);font-weight:600}
.deckmd-runtime .deck-nav{display:flex;align-items:center;justify-content:center;gap:16px;margin-top:18px;
  font:12px monospace;color:#a0aec0;position:sticky;bottom:0;background:#fff;padding:8px 0}
.deckmd-runtime .deck-nav button{cursor:pointer;background:none;border:none;font-size:16px;color:inherit}
.deckmd-runtime .deck-nav button:disabled{opacity:.4;cursor:default}`;

const mdit = MarkdownIt({ html: false, linkify: false });

/** Split deck markdown into per-slide chunks ("## " starts a slide). */
function deckToSlides(markdown: string): string[] {
  const slides: string[] = [];
  let cur: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("## ")) {
      if (cur.join("").trim().length > 0) slides.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.join("").trim().length > 0) slides.push(cur.join("\n"));
  return slides.length > 0 ? slides : [markdown];
}

export function DeckPreview({ fileId }: { fileId: string }) {
  const [data, setData] = useState<ReadDeckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

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

  // ── Vue island: markdown runtime + slide state + nav ──
  useEffect(() => {
    const host = hostRef.current;
    if (host == null || data?.markdown == null) return;
    const slides = deckToSlides(data.markdown);
    if (slides.length === 0) return;
    const rendered = slides.map((s) => mdit.render(s));
    const state = reactive({ index: 0, total: slides.length });
    const go = (d: number) => {
      state.index = Math.min(slides.length - 1, Math.max(0, state.index + d));
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    };
    window.addEventListener("keydown", onKey);
    const app = createApp({
      setup() {
        return { state, rendered, go };
      },
      template: `
        <div class="deckmd-runtime">
          <!-- biome-ignore lint/security/noDangerouslySetInnerHtml: markdown-it with html:false over server-sanitized deck content -->
          <div v-html="rendered[state.index]"></div>
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
    };
  }, [data]);

  const openFull = useCallback(() => {
    void tauriOpenFile(fileId).catch(() => {});
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
      <style dangerouslySetInnerHTML={{ __html: RUNTIME_CSS }} />
      {/* Markdown compiled by the embedded Vue runtime — deck content is
          sanitized server-side before storage; html:false in markdown-it
          keeps the rendering inert. */}
      <div className="relative aspect-video w-full overflow-hidden rounded-lg border bg-white">
        <div ref={hostRef} className="h-full w-full" />
      </div>
      <div className="flex items-center justify-center gap-2">
        <Button onClick={openFull} size="sm" variant="outline">
          <ExternalLinkIcon className="size-3.5" /> Open full deck
        </Button>
      </div>
    </div>
  );
}
