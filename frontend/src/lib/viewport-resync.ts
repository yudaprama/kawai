import { logInfo } from "@/lib/logger";

/**
 * Viewport re-sync after a background→foreground switch.
 *
 * The shell is sized entirely by CSS viewport metrics — `h-dvh` on the app
 * shell (`app/App.tsx`) and `env(safe-area-inset-*)` through the `index.css`
 * `safe-t`/`safe-b`/`safe-x` utilities — and `html { overflow: clip }` removes
 * the scroll fallback, so a stale metric is not recoverable by the user. The
 * Android Activity is never recreated for window changes (`configChanges` in
 * `AndroidManifest.xml`), so nothing re-measures on resume: the WebView keeps
 * the viewport and insets it had before the switch (typically captured with
 * the IME up) and the app renders against stale geometry until an unrelated
 * resize fires.
 *
 * `MainActivity.onResume` re-dispatches the window insets, forces a relayout
 * and calls `window.__kawaiResyncViewport`. This module owns that entry point
 * plus the browser-level equivalents (`visibilitychange`, `pageshow`,
 * `visualViewport.resize`). Every resync flushes style/layout so the freshly
 * resolved values are applied before the next paint, notifies `resize`
 * listeners, and logs the metrics — `[viewport] …` in `app.log` and Loki
 * (INFO), the diagnostic for this intermittent bug.
 */

declare global {
  interface Window {
    __kawaiResyncViewport?: (reason?: string) => void;
  }
}

type Insets = { top: number; right: number; bottom: number; left: number };

let probe: HTMLDivElement | null = null;

/** Read the resolved `env(safe-area-inset-*)` values through a throwaway box. */
function readInsets(): Insets {
  if (probe == null) {
    probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;" +
      "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)";
    document.body.appendChild(probe);
  }
  const cs = getComputedStyle(probe);
  return {
    top: parseFloat(cs.paddingTop) || 0,
    right: parseFloat(cs.paddingRight) || 0,
    bottom: parseFloat(cs.paddingBottom) || 0,
    left: parseFloat(cs.paddingLeft) || 0,
  };
}

/** One line carrying every metric the layout depends on. */
function snapshot(): string {
  const vv = window.visualViewport;
  const de = document.documentElement;
  const i = readInsets();
  return [
    `inner=${window.innerHeight}x${window.innerWidth}`,
    `doc=${de.clientHeight}x${de.clientWidth}`,
    vv ? `vv=${Math.round(vv.height)}x${Math.round(vv.width)}+${Math.round(vv.offsetTop)}@${vv.scale}` : "vv=none",
    `insets=${i.top}/${i.right}/${i.bottom}/${i.left}`,
  ].join(" ");
}

function resync(reason: string): void {
  // Flush style + layout: the renderer has just been told its size/insets
  // again, and reading a layout property forces the recalc now instead of
  // letting it be served from the pre-background layout object.
  void document.documentElement.offsetHeight;
  void document.body.offsetHeight;
  // Re-notify measurement consumers (ResizeObserver users get their own
  // callback; this covers plain listeners).
  window.dispatchEvent(new Event("resize"));
  logInfo("viewport", `${reason} ${snapshot()}`);
}

let installed = false;

/**
 * Install the resync entry point and its browser-level triggers. Idempotent.
 * Called once from `main.tsx` before React mounts, so the global exists even
 * while the app shows a gate or fallback.
 */
export function installViewportResync(): void {
  if (installed) return;
  installed = true;

  window.__kawaiResyncViewport = (reason = "resume") => resync(reason);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) resync("visible");
  });
  window.addEventListener("pageshow", () => resync("pageshow"));
  // The IME and zoom change the visual viewport without touching the window.
  window.visualViewport?.addEventListener("resize", () => resync("vv-resize"));
}
