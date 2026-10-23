import { useCallback, useEffect, useState } from "react";
import { applyPalette, getPalette, setPalette, usePaletteId } from "@/lib/themes";
import { setStatusBarLightIcons } from "@/platform/status-bar";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "kawai-theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyTheme(theme: Theme): ResolvedTheme {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  // Android edge-to-edge: the status-bar icon contrast must follow the APP's
  // dark mode (this class toggle), not the system one — MainActivity's
  // enableEdgeToEdge() defaults to the system, which can paint dark icons on
  // the dark app. `KawaiStatusBar` is the JavascriptInterface registered in
  // MainActivity.onWebViewCreate; absent on desktop/web, so the optional
  // chain is the guard.
  setStatusBarLightIcons(!dark);
  return dark ? "dark" : "light";
}

function readInitial(): Theme {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(readInitial);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    theme === "dark" || (theme === "system" && systemPrefersDark()) ? "dark" : "light",
  );

  const setTheme = useCallback((next: Theme) => {
    setThemeState(next);
    window.localStorage.setItem(STORAGE_KEY, next);
    setResolvedTheme(applyTheme(next));
  }, []);

  // Apply on mount and re-apply live when in "system" mode (OS preference change).
  useEffect(() => {
    setResolvedTheme(applyTheme(theme));
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolvedTheme(applyTheme("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);

  // The palette (color theme) is orthogonal to the light/dark/system mode:
  // repaint its tokens whenever either side changes.
  const paletteId = usePaletteId();
  useEffect(() => {
    applyPalette(getPalette(paletteId), resolvedTheme);
  }, [paletteId, resolvedTheme]);

  return { theme, setTheme, resolvedTheme, paletteId, setPalette };
}
