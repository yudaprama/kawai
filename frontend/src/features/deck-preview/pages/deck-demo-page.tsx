import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createApp, reactive } from "vue/dist/vue.esm-bundler.js";
import MarkdownIt from "markdown-it";

import { Button } from "@/components/ui/button";

/**
 * PoC page — Slidev-style markdown slide runtime running natively in the
 * app's webview (Vue + markdown-it, no iframe, no reveal.js, no backend).
 *
 * Markdown in → slides out: the deck source is a plain markdown string
 * (the exact shape the LLM emits and `office_read_deck` serves), compiled
 * at runtime and rendered as plain DOM inside a 16:9 frame that scales to
 * the available space. Navigation: ← → keys, buttons, or dots.
 */

const RUNTIME_CSS = `.deckmd-stage{position:relative;flex:1;min-height:0;overflow:hidden}
.deckmd-frame{position:absolute;top:50%;left:50%;width:980px;height:551px;
  transform:translate(-50%,-50%) scale(var(--deckmd-scale,1));
  background:#fff;color:#1a202c;
  font-family:Poppins,ui-sans-serif,-apple-system,'Segoe UI',sans-serif;
  padding:46px 60px;box-sizing:border-box;overflow:hidden;
  display:flex;flex-direction:column}
.deckmd-frame h1{font-size:2.6em;line-height:1.15;font-weight:600;margin:0 0 18px;letter-spacing:-.02em}
.deckmd-frame h2{font-size:1.7em;line-height:1.25;font-weight:600;margin:0 0 18px;letter-spacing:-.02em;color:var(--slidev-primary,#3ab9d5)}
.deckmd-frame p{font-size:1.05em;line-height:1.65;margin:0 0 10px;color:#4a5568}
.deckmd-frame ul{padding-left:1.2em;margin:6px 0}
.deckmd-frame li{font-size:1.05em;line-height:1.9;color:#2d3748}
.deckmd-frame li::marker{color:var(--slidev-primary,#3ab9d5)}
.deckmd-frame strong{color:var(--slidev-primary,#3ab9d5);font-weight:600}
.deckmd-frame blockquote{border-left:4px solid var(--slidev-primary,#3ab9d5);margin:16px 0;padding:4px 18px;font-style:italic;color:#2d3748}
.deckmd-frame table{border-collapse:collapse;font-size:.95em;margin:10px 0;width:100%}
.deckmd-frame th,.deckmd-frame td{border-bottom:1px solid #e2e8f0;padding:8px 12px;text-align:left}
.deckmd-frame th{color:var(--slidev-primary,#3ab9d5);font-weight:600}`;

/** Demo deck — the exact markdown shape the LLM emits / `office_read_deck`
 *  serves. Editing this string updates the slides live. */
const DECK_MARKDOWN = `# Tren 2025: **AI** di front, efisiensi di belakang
Riset lintas sumber: teknologi, pasar, perilaku konsumen

---

## Yang semakin cepat

- Agen AI masuk alur kerja produksi
- On-device inference turun biaya
- **Regulasi** mulai di-enforce

---

## Yang ditinggalkan

- Dashboards tanpa narasi
- Proses manual di antara tools

> Buy less, choose well.

---

| Sinyal | Arah |
| --- | --- |
| Biaya inferensi | turun |
| On-device | naik |

---

# Siap mencoba?`;

const mdit = MarkdownIt({ html: false, linkify: false });

/** Split deck markdown into per-slide chunks ("#"/"##" start new slides). */
function deckToSlides(markdown: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  for (const line of markdown.split("\n")) {
    if (line.startsWith("# ") || line.startsWith("## ")) {
      if (cur.join("").trim().length > 0) out.push(cur.join("\n"));
      cur = [line];
    } else {
      cur.push(line);
    }
  }
  if (cur.join("").trim().length > 0) out.push(cur.join("\n"));
  return out.length > 0 ? out : [markdown];
}

export function DeckDemoPage({ onBack }: { onBack: () => void }) {
  const [index, setIndex] = useState(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // split deck markdown → per-slide markdown chunks
  const slides = useMemo(() => deckToSlides(DECK_MARKDOWN), []);

  const go = useCallback(
    (d: number) => setIndex((i) => Math.min(slides.length - 1, Math.max(0, i + d))),
    [slides.length],
  );

  // scale: fixed 980×551 canvas → fit the available stage
  useEffect(() => {
    const el = stageRef.current;
    if (el == null) return;
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) {
        el.style.setProperty("--deckmd-scale", String(Math.min(width / 980, height / 551)));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Vue island: markdown runtime, re-renders when the index changes ──
  const rendered = useMemo(() => slides.map((s) => mdit.render(s)), [slides]);
  const vstate = useMemo(() => reactive({ html: "", index: 0, total: slides.length }), [slides]);

  useEffect(() => {
    const host = hostRef.current;
    if (host == null) return;
    const app = createApp({
      setup() {
        return { state: vstate };
      },
      template: `
        <div class="deckmd-frame">
          <div v-html="state.html"></div>
          <div class="deckmd-nav">
            <button :disabled="state.index===0" @click="state.index=Math.max(0,state.index-1)">←</button>
            <span>{{ state.index + 1 }} / {{ state.total }}</span>
            <button :disabled="state.index===state.total-1" @click="state.index=Math.min(state.total-1,state.index+1)">→</button>
          </div>
        </div>`,
    });
    app.mount(host);
    return () => app.unmount();
  }, [vstate]);

  // React owns the index; sync it into the Vue island reactively
  useEffect(() => {
    vstate.index = index;
    vstate.html = rendered[index] ?? "";
  }, [index, rendered, vstate]);

  return (
    <div className="bg-background text-foreground flex h-dvh flex-col overflow-hidden">
      <style dangerouslySetInnerHTML={{ __html: RUNTIME_CSS }} />
      <div className="border-border/60 flex items-center gap-3 border-b px-4 py-2">
        <Button onClick={onBack} size="sm" variant="ghost">
          Back
        </Button>
        <span className="text-muted-foreground font-mono text-xs uppercase">
          Deck Preview · Slidev-style markdown runtime · PoC
        </span>
      </div>

      <div className="deckmd-stage" ref={stageRef}>
        <div ref={hostRef} />
      </div>

      <div className="border-border/60 flex items-center justify-center gap-4 border-t px-4 py-2">
        <Button disabled={index === 0} onClick={() => go(-1)} size="icon" variant="ghost">
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="flex items-center gap-1.5">
          {slides.map((_, i) => (
            <button
              aria-label={`Slide ${i + 1}`}
              className={
                i === index
                  ? "bg-primary size-2 rounded-full"
                  : "bg-muted-foreground/30 hover:bg-muted-foreground/60 size-2 rounded-full"
              }
              // biome-ignore lint/suspicious/noArrayIndexKey: static demo slide list
              key={i}
              onClick={() => setIndex(i)}
              type="button"
            />
          ))}
        </div>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {index + 1} / {slides.length}
        </span>
        <Button disabled={index === slides.length - 1} onClick={() => go(1)} size="icon" variant="ghost">
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
