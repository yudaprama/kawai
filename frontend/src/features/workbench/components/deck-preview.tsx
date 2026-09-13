import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { call, errText, tauriOpenFile } from "@/lib/api";

/**
 * Slidev-style native slide preview for a stored deck (office_create_deck
 * output) — VERBATIM port of the approved PoC (deck-demo-page): fixed 16:9
 * canvas at 980×551 scaled with a single CSS transform, content as plain
 * sanitized DOM. The backend op `office_read_deck` supplies theme CSS +
 * section fragments; long slides scroll INSIDE the canvas. Full-fidelity
 * presentation via "Open full deck" in the system browser.
 */

const CANVAS_W = 980;
const CANVAS_H = 551;

/** Base container css for the bare preview (reveal.css equivalents). */
const SCOPE_CSS = `.deck-scope{box-sizing:border-box;width:${CANVAS_W}px;height:${CANVAS_H}px;
padding:52px 64px;background:var(--bg);color:var(--text-1);
font-family:var(--font-sans);overflow:hidden}
.deck-scope>div{width:100%;margin:auto 0}
.deck-scope h2{margin-bottom:18px}`;

interface ReadDeckResult {
  title?: string | null;
  template?: string | null;
  themeCss: string;
  slides: string[];
}

function useCanvasScale() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = containerRef.current;
    if (el == null) return;
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setScale(Math.min(width / CANVAS_W, height / CANVAS_H));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { containerRef, scale };
}

export function DeckPreview({ fileId }: { fileId: string }) {
  const [data, setData] = useState<ReadDeckResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const { containerRef, scale } = useCanvasScale();

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    setIndex(0);
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

  const total = data?.slides.length ?? 0;
  const go = useCallback(
    (delta: number) => setIndex((i) => Math.min(total - 1, Math.max(0, i + delta))),
    [total],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const slide = data?.slides[index];
  // PowerPoint-style shrink-to-fit: if the slide's natural content height
  // exceeds the canvas, scale the content down (never scroll — a slide is a
  // slide). Natural height = inner div offsetHeight (layout-based, unaffected
  // by its own transform). Re-measured on slide change, font load, resize.
  const scopeRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const scope = scopeRef.current;
    if (scope == null) return;
    const inner = scope.firstElementChild as HTMLElement | null;
    if (inner == null) return;
    const refit = () => {
      const avail = scope.clientHeight - 104; // 52px × 2 padding
      const natural = inner.offsetHeight;
      if (avail > 0 && natural > 0) setFit(Math.min(1, avail / natural));
    };
    refit();
    const ro = new ResizeObserver(refit);
    ro.observe(inner);
    document.fonts?.ready.then(refit).catch(() => {});
    return () => ro.disconnect();
  }, [slide]);

  if (error != null) {
    return (
      <div className="text-muted-foreground flex items-center justify-center p-8 font-mono text-xs">
        Deck preview failed: {error}
      </div>
    );
  }
  if (data == null || slide == null) {
    return (
      <div className="text-muted-foreground flex items-center justify-center p-8 font-mono text-xs">
        Loading deck…
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <style dangerouslySetInnerHTML={{ __html: SCOPE_CSS + "\n" + data.themeCss }} />
      {/* Fragments are sanitized server-side (sanitize_html_fragment +
          probe_deck) before the deck is ever stored — no scripts, no remote
          URLs. */}
      <div ref={containerRef} className="relative h-[480px] overflow-hidden rounded-lg border">
        <div
          className="absolute top-1/2 left-1/2"
          style={{
            width: CANVAS_W,
            height: CANVAS_H,
            transform: `translate(-50%, -50%) scale(${scale})`,
          }}
        >
          <div className="deck-scope" ref={scopeRef}>
            <div style={{ transform: `scale(${fit})`, transformOrigin: "center center" }} dangerouslySetInnerHTML={{ __html: slide }} />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-center gap-4">
        <Button disabled={index === 0} onClick={() => go(-1)} size="icon" variant="ghost">
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="flex items-center gap-1.5">
          {data.slides.map((_, i) => (
            <button
              aria-label={`Slide ${i + 1}`}
              className={
                i === index
                  ? "bg-primary size-2 rounded-full"
                  : "bg-muted-foreground/30 hover:bg-muted-foreground/60 size-2 rounded-full"
              }
              key={i}
              onClick={() => setIndex(i)}
              type="button"
            />
          ))}
        </div>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {index + 1} / {total}
        </span>
        <Button disabled={index === total - 1} onClick={() => go(1)} size="icon" variant="ghost">
          <ArrowRightIcon className="size-4" />
        </Button>
        <Button onClick={() => void tauriOpenFile(fileId).catch(() => {})} size="sm" variant="outline">
          <ExternalLinkIcon className="size-3.5" /> Open full deck
        </Button>
      </div>
    </div>
  );
}
