import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * Edge state for a horizontal scroller: `showStart`/`showEnd` report whether
 * content is hidden past each edge, so a fade only appears where something
 * is actually scrolled out of view (touch users otherwise have no scrollbar
 * hint that a chip strip continues). Re-checks on scroll, element resize
 * (rotation), and `watch` — pass the value whose changes add/remove content
 * (e.g. the item count).
 */
export function useXOverflow<T extends HTMLElement>(watch?: unknown) {
  const ref = useRef<T | null>(null);
  const [showStart, setShowStart] = useState(false);
  const [showEnd, setShowEnd] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `watch` is the re-check TRIGGER (content growth) — the effect reads the DOM, not the value
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => {
      const max = el.scrollWidth - el.clientWidth;
      setShowStart(el.scrollLeft > 1);
      setShowEnd(el.scrollLeft < max - 1);
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, [watch]);
  return { ref, showStart, showEnd };
}

/**
 * Pair of background-to-transparent gradients over a `relative` container's
 * edges, rendered only on the side(s) with hidden content. Colors follow the
 * `--background` token so they sit on any surface the app paints.
 */
export function EdgeFades({
  className,
  showEnd = false,
  showStart = false,
}: {
  className?: string;
  showEnd?: boolean;
  showStart?: boolean;
}) {
  return (
    <>
      {showStart && (
        <div
          aria-hidden
          className={cn(
            "from-background pointer-events-none absolute inset-y-0 left-0 z-10 w-10 bg-gradient-to-r to-transparent",
            className,
          )}
        />
      )}
      {showEnd && (
        <div
          aria-hidden
          className={cn(
            "from-background pointer-events-none absolute inset-y-0 right-0 z-10 w-10 bg-gradient-to-l to-transparent",
            className,
          )}
        />
      )}
    </>
  );
}
