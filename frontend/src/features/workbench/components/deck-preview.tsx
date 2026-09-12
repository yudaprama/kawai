import { ArrowLeftIcon, ArrowRightIcon, ExternalLinkIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { call, errText, tauriOpenFile } from "@/lib/api";

/**
 * Slidev-style native slide preview for a stored deck (office_create_deck
 * output). The backend op `office_read_deck` splits the stored HTML into
 * sanitized `<section>` fragments + theme CSS (no reveal runtime, no fonts
 * inlined beyond the theme's own) — this component renders ONE slide at a
 * time as plain DOM inside a fixed 16:9 canvas scaled with a single CSS
 * transform. A few KB per slide instead of the ~300 KB data:-URL iframe.
 *
 * Full-fidelity presentation (animations, keyboard nav) stays available via
 * "Open full deck" — the reveal.js file opens in the system browser, outside
 * the app process.
 */

const CANVAS_W = 980;
const CANVAS_H = 551;

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

  const go = useCallback(
    (delta: number) =>
      setIndex((i) => {
        const total = data?.slides.length ?? 1;
        return Math.min(total - 1, Math.max(0, i + delta));
      }),
    [data?.slides.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const slide = useMemo(() => data?.slides[index], [data, index]);

  if (error != null) {
    return (
      <div className="text-muted-foreground flex items-center justify-center p-8 font-mono text-xs">
        Deck preview failed: {error}
      </div>
    );
  }
  if (data == null || data.slides.length === 0) {
    return (
      <div className="text-muted-foreground flex items-center justify-center p-8 font-mono text-xs">
        Loading deck…
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <style dangerouslySetInnerHTML={{ __html: data.themeCss }} />
      <div ref={containerRef} className="relative h-[480px] overflow-hidden rounded-lg border">
        {slide != null && (
          <div
            className="absolute top-1/2 left-1/2"
            style={{
              width: CANVAS_W,
              height: CANVAS_H,
              transform: `translate(-50%, -50%) scale(${scale})`,
            }}
          >
            {/* Fragments are sanitized server-side (sanitize_html_fragment +
                probe_deck) before the deck is ever stored — no scripts, no
                remote URLs. */}
            <div className="deck-scope h-full w-full" dangerouslySetInnerHTML={{ __html: slide }} />
          </div>
        )}
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
          {index + 1} / {data.slides.length}
        </span>
        <Button
          disabled={index === data.slides.length - 1}
          onClick={() => go(1)}
          size="icon"
          variant="ghost"
        >
          <ArrowRightIcon className="size-4" />
        </Button>
        <Button onClick={() => void tauriOpenFile(fileId).catch(() => {})} size="sm" variant="outline">
          <ExternalLinkIcon className="size-3.5" /> Open full deck
        </Button>
      </div>
    </div>
  );
}
