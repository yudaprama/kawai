import { useSyncExternalStore } from "react";

/**
 * Theme palettes — the user-pickable *color* theme of the app, layered on top
 * of the light/dark/system mode (`hooks/use-theme.ts`).
 *
 * A palette is nothing but the shadcn semantic custom properties
 * (`--background`, `--primary`, …) for each mode. Applying one sets them as
 * inline custom properties on `<html>`, so it overrides whatever
 * `index.css` declares in `:root` / `.dark` without a second stylesheet, and
 * switching back to the built-in palette removes them again (the stylesheet
 * values take over).
 *
 * Palettes can come from the public tweakcn / shadcn theme registries, which
 * both serve CORS-enabled JSON:
 *   - https://tweakcn.com/r/themes/<id>            (registry item: cssVars.light/dark)
 *   - https://ui.shadcn.com/r/themes/<name>.json  (preset: zinc, stone, slate, gray)
 * A bare word ("zinc") is treated as a shadcn preset name.
 *
 * The active palette is snapshotted into localStorage on every apply so the
 * inline script in `index.html` can replay the tokens *before first paint* —
 * without it the app would flash the stylesheet palette on every launch.
 */

export interface ThemePalette {
  id: string;
  label: string;
  /** Where the palette came from (registry URL), for the "remove" affordance. */
  source?: string;
  /** Imported by the user (as opposed to bundled) — removable. */
  custom?: boolean;
  /** Overrides `--radius` when the theme ships its own. */
  radius?: string;
  /** Semantic tokens for light mode; omitted keys keep the stylesheet value. */
  light: Record<string, string>;
  /** Semantic tokens for dark mode; omitted keys keep the stylesheet value. */
  dark: Record<string, string>;
  /** Preview colors (background, card, primary, accent) — defaults to `light`. */
  swatch?: string[];
}

const PALETTE_KEY = "kawai-palette";
const CUSTOM_KEY = "kawai-palettes";
/** Read by the pre-paint script in `index.html` — keep the key in sync. */
const SNAPSHOT_KEY = "kawai-palette-vars";

/**
 * The built-in neutral-mono palette from `index.css`. Ships no tokens: it IS
 * the stylesheet. Only the preview colors are listed, so the card shows the
 * palette the app falls back to.
 */
const MONO: ThemePalette = {
  id: "mono",
  label: "Mono",
  light: {},
  dark: {},
  swatch: ["hsl(0 0% 100%)", "hsl(0 0% 97.0588%)", "hsl(0 0% 0%)", "hsl(0 0% 94.1176%)"],
};

/** tweakcn "New Vekis Theme" — https://tweakcn.com/r/themes/cmurhgq4b000004jph1r1h7u1 */
const VEKIS: ThemePalette = {
  id: "vekis",
  label: "Vekis",
  source: "https://tweakcn.com/r/themes/cmurhgq4b000004jph1r1h7u1",
  radius: "0.75rem",
  light: {
    background: "oklch(0.9383 0.0042 236.4993)",
    foreground: "oklch(0.3211 0 0)",
    card: "oklch(1.0000 0 0)",
    "card-foreground": "oklch(0.3211 0 0)",
    popover: "oklch(1.0000 0 0)",
    "popover-foreground": "oklch(0.3211 0 0)",
    primary: "oklch(0.6397 0.1720 36.4421)",
    "primary-foreground": "oklch(1.0000 0 0)",
    secondary: "oklch(0.9670 0.0029 264.5419)",
    "secondary-foreground": "oklch(0.4461 0.0263 256.8018)",
    muted: "oklch(0.9846 0.0017 247.8389)",
    "muted-foreground": "oklch(0.5510 0.0234 264.3637)",
    accent: "oklch(0.9119 0.0222 243.8174)",
    "accent-foreground": "oklch(0.3791 0.1378 265.5222)",
    destructive: "oklch(0.6368 0.2078 25.3313)",
    "destructive-foreground": "oklch(1.0000 0 0)",
    border: "oklch(0.9022 0.0052 247.8822)",
    input: "oklch(0.9700 0.0029 264.5420)",
    ring: "oklch(0.6397 0.1720 36.4421)",
    "chart-1": "oklch(0.7156 0.0605 248.6845)",
    "chart-2": "oklch(0.7875 0.0917 35.9616)",
    "chart-3": "oklch(0.5778 0.0759 254.1573)",
    "chart-4": "oklch(0.5016 0.0849 259.4902)",
    "chart-5": "oklch(0.4241 0.0952 264.0306)",
    sidebar: "oklch(0.9030 0.0046 258.3257)",
    "sidebar-foreground": "oklch(0.3211 0 0)",
    "sidebar-primary": "oklch(0.6397 0.1720 36.4421)",
    "sidebar-primary-foreground": "oklch(1.0000 0 0)",
    "sidebar-accent": "oklch(0.9119 0.0222 243.8174)",
    "sidebar-accent-foreground": "oklch(0.3791 0.1378 265.5222)",
    "sidebar-border": "oklch(0.9276 0.0058 264.5313)",
    "sidebar-ring": "oklch(0.6397 0.1720 36.4421)",
  },
  dark: {
    background: "oklch(0.2598 0.0306 262.6666)",
    foreground: "oklch(0.9219 0 0)",
    card: "oklch(0.3106 0.0301 268.6365)",
    "card-foreground": "oklch(0.9219 0 0)",
    popover: "oklch(0.2900 0.0249 268.3986)",
    "popover-foreground": "oklch(0.9219 0 0)",
    primary: "oklch(0.6397 0.1720 36.4421)",
    "primary-foreground": "oklch(1.0000 0 0)",
    secondary: "oklch(0.3095 0.0266 266.7132)",
    "secondary-foreground": "oklch(0.9219 0 0)",
    muted: "oklch(0.3095 0.0266 266.7132)",
    "muted-foreground": "oklch(0.7155 0 0)",
    accent: "oklch(0.3380 0.0589 267.5867)",
    "accent-foreground": "oklch(0.8823 0.0571 254.1284)",
    destructive: "oklch(0.6368 0.2078 25.3313)",
    "destructive-foreground": "oklch(1.0000 0 0)",
    border: "oklch(0.3843 0.0301 269.7337)",
    input: "oklch(0.3843 0.0301 269.7337)",
    ring: "oklch(0.6397 0.1720 36.4421)",
    "chart-1": "oklch(0.7156 0.0605 248.6845)",
    "chart-2": "oklch(0.7693 0.0876 34.1875)",
    "chart-3": "oklch(0.5778 0.0759 254.1573)",
    "chart-4": "oklch(0.5016 0.0849 259.4902)",
    "chart-5": "oklch(0.4241 0.0952 264.0306)",
    sidebar: "oklch(0.3100 0.0283 267.7408)",
    "sidebar-foreground": "oklch(0.9219 0 0)",
    "sidebar-primary": "oklch(0.6397 0.1720 36.4421)",
    "sidebar-primary-foreground": "oklch(1.0000 0 0)",
    "sidebar-accent": "oklch(0.3380 0.0589 267.5867)",
    "sidebar-accent-foreground": "oklch(0.8823 0.0571 254.1284)",
    "sidebar-border": "oklch(0.3843 0.0301 269.7337)",
    "sidebar-ring": "oklch(0.6397 0.1720 36.4421)",
  },
};

const BUNDLED: ThemePalette[] = [MONO, VEKIS];

// ---------------------------------------------------------------------------
// Custom palettes (localStorage)

function isPalette(value: unknown): value is ThemePalette {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Partial<ThemePalette>;
  return typeof p.id === "string" && typeof p.label === "string" && !!p.light && !!p.dark;
}

function readCustom(): ThemePalette[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CUSTOM_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isPalette).map((p) => ({ ...p, custom: true })) : [];
  } catch {
    return [];
  }
}

let customPalettes = readCustom();
let allPalettes = [...BUNDLED, ...customPalettes];
let currentId = allPalettes[0].id;
try {
  const stored = window.localStorage.getItem(PALETTE_KEY);
  if (stored && allPalettes.some((p) => p.id === stored)) currentId = stored;
} catch {
  /* private mode / SSR — the default palette stands */
}

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function persistCustom(): void {
  try {
    window.localStorage.setItem(CUSTOM_KEY, JSON.stringify(customPalettes));
  } catch {
    /* quota / private mode — the palette still applies for this session */
  }
}

export function subscribePalettes(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Bundled + imported palettes, in pick order. Cached identity (store contract). */
export function getPalettes(): ThemePalette[] {
  return allPalettes;
}

export function getPaletteId(): string {
  return currentId;
}

export function getPalette(id: string): ThemePalette {
  return allPalettes.find((p) => p.id === id) ?? allPalettes[0];
}

export function setPalette(id: string): void {
  if (!allPalettes.some((p) => p.id === id)) return;
  currentId = id;
  try {
    window.localStorage.setItem(PALETTE_KEY, id);
  } catch {
    /* ignore */
  }
  emit();
}

/** Drop an imported palette; the built-ins stay. */
export function removeCustomPalette(id: string): void {
  customPalettes = customPalettes.filter((p) => p.id !== id);
  persistCustom();
  allPalettes = [...BUNDLED, ...customPalettes];
  if (currentId === id) setPalette(allPalettes[0].id);
  emit();
}

// ---------------------------------------------------------------------------
// Applying a palette

/** Token names currently written as inline custom properties on <html>. */
let appliedTokens = new Set<string>();

function writeSnapshot(palette: ThemePalette): void {
  try {
    window.localStorage.setItem(
      SNAPSHOT_KEY,
      JSON.stringify({ id: palette.id, light: palette.light, dark: palette.dark }),
    );
  } catch {
    /* ignore */
  }
}

/**
 * Paint `palette` in `mode` by setting its tokens inline on `<html>`; tokens the
 * palette doesn't define (and leftovers from the previous palette) are removed
 * so the stylesheet values in `index.css` show through again.
 */
export function applyPalette(palette: ThemePalette, mode: "light" | "dark"): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const next = mode === "dark" ? palette.dark : palette.light;
  const keys = new Set(Object.keys(next));

  for (const key of appliedTokens) {
    if (!keys.has(key)) root.style.removeProperty(`--${key}`);
  }
  for (const [key, value] of Object.entries(next)) {
    root.style.setProperty(`--${key}`, value);
  }
  if (palette.radius) {
    root.style.setProperty("--radius", palette.radius);
    keys.add("radius");
  } else if (appliedTokens.has("radius")) {
    root.style.removeProperty("--radius");
  }
  appliedTokens = keys;
  writeSnapshot(palette);
}

// ---------------------------------------------------------------------------
// Importing from the tweakcn / shadcn registries

/** `hsl(0 0% 100%)` — the shadcn presets ship bare `0 0% 100%` triplets. */
function normalizeColor(value: string): string {
  const trimmed = value.trim();
  if (!/^[\d.]+ [\d.]+% [\d.]+%(\s*\/\s*[\d.]+)?$/.test(trimmed)) return trimmed;
  return `hsl(${trimmed.replace(/\s*\/\s*/, " / ")})`;
}

function normalizeTokens(source: Record<string, string> | undefined): Record<string, string> {
  if (!source) return {};
  return Object.fromEntries(Object.entries(source).map(([key, value]) => [key, normalizeColor(value)]));
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "theme";
}

type RegistryItem = {
  name?: string;
  label?: string;
  cssVars?: { light?: Record<string, string>; dark?: Record<string, string>; theme?: Record<string, string> };
};

/** "zinc" → the shadcn preset; a URL → used as-is. */
function resolveSource(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^[\w-]+$/.test(trimmed)) return `https://ui.shadcn.com/r/themes/${trimmed.toLowerCase()}.json`;
  throw new Error("Not a theme link or preset name");
}

function idFromSource(url: string, label: string): string {
  const segment = url.split("?")[0].replace(/\/+$/, "").split("/").pop() ?? "";
  return slugify(segment.replace(/\.json$/, "") || label);
}

/**
 * Fetch a palette from the tweakcn or shadcn registry and add it to the
 * user's list. Returns the stored palette (re-importing the same source
 * refreshes it in place). Throws with a short English reason on failure.
 */
export async function importPalette(input: string): Promise<ThemePalette> {
  const url = resolveSource(input);
  let item: RegistryItem;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    item = (await res.json()) as RegistryItem;
  } catch (error) {
    throw new Error(`Could not fetch ${url}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const light = normalizeTokens(item.cssVars?.light);
  const dark = normalizeTokens(item.cssVars?.dark);
  if (!light.background || !light.primary) {
    throw new Error(`${url} is not a shadcn theme registry item`);
  }

  const label = item.label ?? item.name ?? idFromSource(url, "theme");
  const palette: ThemePalette = {
    id: idFromSource(url, label),
    label: label.replace(/\s+theme$/i, ""),
    source: url,
    custom: true,
    radius: item.cssVars?.theme?.radius,
    light,
    dark,
  };

  customPalettes = [...customPalettes.filter((p) => p.id !== palette.id), palette];
  persistCustom();
  allPalettes = [...BUNDLED, ...customPalettes];
  setPalette(palette.id);
  emit();
  return palette;
}

// ---------------------------------------------------------------------------
// React bindings

export function usePalettes(): ThemePalette[] {
  return useSyncExternalStore(subscribePalettes, getPalettes, getPalettes);
}

export function usePaletteId(): string {
  return useSyncExternalStore(subscribePalettes, getPaletteId, getPaletteId);
}
