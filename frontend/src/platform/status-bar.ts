/**
 * Android status-bar bridge (edge-to-edge). `MainActivity` registers a
 * `JavascriptInterface` named `KawaiStatusBar`; the app's dark mode is
 * localStorage-driven (not the system one), so the icon contrast has to be
 * pushed from JS whenever the theme resolves. Desktop/web never define the
 * global — the optional chain is the guard.
 */

declare global {
  interface Window {
    KawaiStatusBar?: {
      setLightIcons(light: boolean): void;
    };
  }
}

export function setStatusBarLightIcons(light: boolean): void {
  window.KawaiStatusBar?.setLightIcons(light);
}
