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
 * Bundled palettes are snapshotted from the tweakcn registry (see each const).

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

/**
 * Non-color token chrome shared by the light and dark halves of the bundled
 * tweakcn palettes (fonts + shadow ramp + spacing) — kept once so a tweak
 * lands in one place. Light halves additionally re-apply `tracking-normal`.
 */
const FONTS_OUTFIT = {
  "font-sans": "Outfit, sans-serif",
  "font-serif": 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  "font-mono": "Geist Mono, ui-monospace, monospace",
} as const;

const FONTS_SYSTEM = {
  "font-sans": 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  "font-serif": 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  "font-mono": "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
} as const;

const FONTS_GEIST = {
  "font-sans": "Geist, sans-serif",
  "font-serif": "Noto Serif Georgian, ui-serif, serif",
  "font-mono": "Geist Mono, monospace",
} as const;

const SHADOWS_STD = {
  "shadow-color": "oklch(0 0 0)",
  "shadow-opacity": "0.1",
  "shadow-blur": "3px",
  "shadow-spread": "0px",
  "shadow-offset-x": "0",
  "shadow-offset-y": "1px",
  "letter-spacing": "0em",
  spacing: "0.25rem",
  "shadow-2xs": "0 1px 3px 0px hsl(0 0% 0% / 0.05)",
  "shadow-xs": "0 1px 3px 0px hsl(0 0% 0% / 0.05)",
  "shadow-sm": "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10)",
  shadow: "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 1px 2px -1px hsl(0 0% 0% / 0.10)",
  "shadow-md": "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 2px 4px -1px hsl(0 0% 0% / 0.10)",
  "shadow-lg": "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 4px 6px -1px hsl(0 0% 0% / 0.10)",
  "shadow-xl": "0 1px 3px 0px hsl(0 0% 0% / 0.10), 0 8px 10px -1px hsl(0 0% 0% / 0.10)",
  "shadow-2xl": "0 1px 3px 0px hsl(0 0% 0% / 0.25)",
} as const;

const SHADOWS_FLAT = {
  "shadow-color": "#000000",
  "shadow-opacity": "0",
  "shadow-blur": "0px",
  "shadow-spread": "0px",
  "shadow-offset-x": "0",
  "shadow-offset-y": "1px",
  "letter-spacing": "0em",
  spacing: "0.25rem",
  "shadow-2xs": "0 1px 0px 0px hsl(0 0% 0% / 0.00)",
  "shadow-xs": "0 1px 0px 0px hsl(0 0% 0% / 0.00)",
  "shadow-sm": "0 1px 0px 0px hsl(0 0% 0% / 0.00), 0 1px 2px -1px hsl(0 0% 0% / 0.00)",
  shadow: "0 1px 0px 0px hsl(0 0% 0% / 0.00), 0 1px 2px -1px hsl(0 0% 0% / 0.00)",
  "shadow-md": "0 1px 0px 0px hsl(0 0% 0% / 0.00), 0 2px 4px -1px hsl(0 0% 0% / 0.00)",
  "shadow-lg": "0 1px 0px 0px hsl(0 0% 0% / 0.00), 0 4px 6px -1px hsl(0 0% 0% / 0.00)",
  "shadow-xl": "0 1px 0px 0px hsl(0 0% 0% / 0.00), 0 8px 10px -1px hsl(0 0% 0% / 0.00)",
  "shadow-2xl": "0 1px 0px 0px hsl(0 0% 0% / 0.00)",
} as const;

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
  label: "Chatgpt",
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

/** tweakcn "Claude +" — https://tweakcn.com/r/themes/cmdght103000n04lh3e2ae93r */
const CLAUDE_PLUS: ThemePalette = {
  id: "claude-plus",
  label: "Claude",
  source: "https://tweakcn.com/r/themes/cmdght103000n04lh3e2ae93r",
  radius: "1rem",
  light: {
    background: "oklch(0.9818 0.0054 95.0986)",
    foreground: "oklch(0.3438 0.0269 95.7226)",
    card: "oklch(0.9665 0.0067 97.3521)",
    "card-foreground": "oklch(0.1908 0.0020 106.5859)",
    popover: "oklch(1.0000 0 0)",
    "popover-foreground": "oklch(0.2671 0.0196 98.9390)",
    primary: "oklch(0.6171 0.1375 39.0427)",
    "primary-foreground": "oklch(1.0000 0 0)",
    secondary: "oklch(0.9245 0.0138 92.9892)",
    "secondary-foreground": "oklch(0.4334 0.0177 98.6048)",
    muted: "oklch(0.9341 0.0153 90.2390)",
    "muted-foreground": "oklch(0.5341 0.0078 97.4503)",
    accent: "oklch(0.9245 0.0138 92.9892)",
    "accent-foreground": "oklch(0.2671 0.0196 98.9390)",
    destructive: "oklch(0.1908 0.0020 106.5859)",
    "destructive-foreground": "oklch(1.0000 0 0)",
    border: "oklch(0.8847 0.0069 97.3627)",
    input: "oklch(0.7621 0.0156 98.3528)",
    ring: "oklch(0.6171 0.1375 39.0427)",
    "chart-1": "oklch(0.5583 0.1276 42.9956)",
    "chart-2": "oklch(0.6898 0.1581 290.4107)",
    "chart-3": "oklch(0.8816 0.0276 93.1280)",
    "chart-4": "oklch(0.8822 0.0403 298.1792)",
    "chart-5": "oklch(0.5608 0.1348 42.0584)",
    sidebar: "oklch(0.9663 0.0080 98.8792)",
    "sidebar-foreground": "oklch(0.3590 0.0051 106.6524)",
    "sidebar-primary": "oklch(0.6171 0.1375 39.0427)",
    "sidebar-primary-foreground": "oklch(0.9881 0 0)",
    "sidebar-accent": "oklch(0.9245 0.0138 92.9892)",
    "sidebar-accent-foreground": "oklch(0.3250 0 0)",
    "sidebar-border": "oklch(0.9401 0 0)",
    "sidebar-ring": "oklch(0.7731 0 0)",
    ...FONTS_OUTFIT,
    ...SHADOWS_STD,
    "tracking-normal": "0em",
  },
  dark: {
    background: "oklch(0.2679 0.0036 106.6427)",
    foreground: "oklch(0.9576 0.0027 106.4494)",
    card: "oklch(0.2928 0.0018 106.5092)",
    "card-foreground": "oklch(0.9818 0.0054 95.0986)",
    popover: "oklch(0.3085 0.0035 106.6039)",
    "popover-foreground": "oklch(0.9211 0.0040 106.4781)",
    primary: "oklch(0.6724 0.1308 38.7559)",
    "primary-foreground": "oklch(0.1908 0.0020 106.5859)",
    secondary: "oklch(0.9818 0.0054 95.0986)",
    "secondary-foreground": "oklch(0.3085 0.0035 106.6039)",
    muted: "oklch(0.2213 0.0038 106.7070)",
    "muted-foreground": "oklch(0.7713 0.0169 99.0657)",
    accent: "oklch(0.2130 0.0078 95.4245)",
    "accent-foreground": "oklch(0.9663 0.0080 98.8792)",
    destructive: "oklch(0.6368 0.2078 25.3313)",
    "destructive-foreground": "oklch(1.0000 0 0)",
    border: "oklch(0.3618 0.0101 106.8928)",
    input: "oklch(0.4336 0.0113 100.2195)",
    ring: "oklch(0.6724 0.1308 38.7559)",
    "chart-1": "oklch(0.5583 0.1276 42.9956)",
    "chart-2": "oklch(0.6898 0.1581 290.4107)",
    "chart-3": "oklch(0.2130 0.0078 95.4245)",
    "chart-4": "oklch(0.3074 0.0516 289.3230)",
    "chart-5": "oklch(0.5608 0.1348 42.0584)",
    sidebar: "oklch(0.2357 0.0024 67.7077)",
    "sidebar-foreground": "oklch(0.8074 0.0142 93.0137)",
    "sidebar-primary": "oklch(0.3250 0 0)",
    "sidebar-primary-foreground": "oklch(0.9881 0 0)",
    "sidebar-accent": "oklch(0.1680 0.0020 106.6177)",
    "sidebar-accent-foreground": "oklch(0.8074 0.0142 93.0137)",
    "sidebar-border": "oklch(0.9401 0 0)",
    "sidebar-ring": "oklch(0.7731 0 0)",
    ...FONTS_OUTFIT,
    ...SHADOWS_STD,
  },
};

/** tweakcn "Tokyo Night" — https://tweakcn.com/r/themes/cmv460rwn000104l7045b3563 */
const TOKYO_NIGHT: ThemePalette = {
  id: "tokyo-night",
  label: "Tokyo Night",
  source: "https://tweakcn.com/r/themes/cmv460rwn000104l7045b3563",
  radius: "0.625rem",
  light: {
    background: "oklch(0.2263 0.0214 280.4871)",
    foreground: "oklch(0.8456 0.0611 274.7629)",
    card: "oklch(0.2040 0.0158 284.9095)",
    "card-foreground": "oklch(0.8456 0.0611 274.7629)",
    popover: "oklch(0.2040 0.0158 284.9095)",
    "popover-foreground": "oklch(0.8456 0.0611 274.7629)",
    primary: "oklch(0.7190 0.1322 264.2022)",
    "primary-foreground": "oklch(0.2263 0.0214 280.4871)",
    secondary: "oklch(0.3056 0.0369 273.2268)",
    "secondary-foreground": "oklch(0.8456 0.0611 274.7629)",
    muted: "oklch(0.3056 0.0369 273.2268)",
    "muted-foreground": "oklch(0.7666 0.0537 275.4924)",
    accent: "oklch(0.3056 0.0369 273.2268)",
    "accent-foreground": "oklch(0.8456 0.0611 274.7629)",
    destructive: "oklch(0.7227 0.1589 10.2758)",
    "destructive-foreground": "oklch(0.2263 0.0214 280.4871)",
    border: "oklch(0.4094 0.0546 274.2735)",
    input: "oklch(0.4094 0.0546 274.2735)",
    ring: "oklch(0.7190 0.1322 264.2022)",
    "chart-1": "oklch(0.7190 0.1322 264.2022)",
    "chart-2": "oklch(0.7953 0.1395 130.1364)",
    "chart-3": "oklch(0.7515 0.1344 299.4992)",
    "chart-4": "oklch(0.7839 0.1057 75.4281)",
    "chart-5": "oklch(0.8200 0.1051 235.7153)",
    sidebar: "oklch(0.2040 0.0158 284.9095)",
    "sidebar-foreground": "oklch(0.8456 0.0611 274.7629)",
    "sidebar-primary": "oklch(0.7190 0.1322 264.2022)",
    "sidebar-primary-foreground": "oklch(0.2263 0.0214 280.4871)",
    "sidebar-accent": "oklch(0.3056 0.0369 273.2268)",
    "sidebar-accent-foreground": "oklch(0.8456 0.0611 274.7629)",
    "sidebar-border": "oklch(0.4094 0.0546 274.2735)",
    "sidebar-ring": "oklch(0.7190 0.1322 264.2022)",
    ...FONTS_SYSTEM,
    ...SHADOWS_STD,
    "tracking-normal": "0em",
  },
  dark: {
    background: "oklch(0.2263 0.0214 280.4871)",
    foreground: "oklch(0.8456 0.0611 274.7629)",
    card: "oklch(0.2040 0.0158 284.9095)",
    "card-foreground": "oklch(0.8456 0.0611 274.7629)",
    popover: "oklch(0.2040 0.0158 284.9095)",
    "popover-foreground": "oklch(0.8456 0.0611 274.7629)",
    primary: "oklch(0.7190 0.1322 264.2022)",
    "primary-foreground": "oklch(0.2263 0.0214 280.4871)",
    secondary: "oklch(0.3056 0.0369 273.2268)",
    "secondary-foreground": "oklch(0.8456 0.0611 274.7629)",
    muted: "oklch(0.3056 0.0369 273.2268)",
    "muted-foreground": "oklch(0.7666 0.0537 275.4924)",
    accent: "oklch(0.3056 0.0369 273.2268)",
    "accent-foreground": "oklch(0.8456 0.0611 274.7629)",
    destructive: "oklch(0.7227 0.1589 10.2758)",
    "destructive-foreground": "oklch(0.2263 0.0214 280.4871)",
    border: "oklch(0.4094 0.0546 274.2735)",
    input: "oklch(0.4094 0.0546 274.2735)",
    ring: "oklch(0.7190 0.1322 264.2022)",
    "chart-1": "oklch(0.7190 0.1322 264.2022)",
    "chart-2": "oklch(0.7953 0.1395 130.1364)",
    "chart-3": "oklch(0.7515 0.1344 299.4992)",
    "chart-4": "oklch(0.7839 0.1057 75.4281)",
    "chart-5": "oklch(0.8200 0.1051 235.7153)",
    sidebar: "oklch(0.2040 0.0158 284.9095)",
    "sidebar-foreground": "oklch(0.8456 0.0611 274.7629)",
    "sidebar-primary": "oklch(0.7190 0.1322 264.2022)",
    "sidebar-primary-foreground": "oklch(0.2263 0.0214 280.4871)",
    "sidebar-accent": "oklch(0.3056 0.0369 273.2268)",
    "sidebar-accent-foreground": "oklch(0.8456 0.0611 274.7629)",
    "sidebar-border": "oklch(0.4094 0.0546 274.2735)",
    "sidebar-ring": "oklch(0.7190 0.1322 264.2022)",
    ...FONTS_SYSTEM,
    ...SHADOWS_STD,
  },
};

/** tweakcn "Muse" — https://tweakcn.com/r/themes/cmu77w83m000104kxbep145by */
const MUSE: ThemePalette = {
  id: "muse",
  label: "Muse",
  source: "https://tweakcn.com/r/themes/cmu77w83m000104kxbep145by",
  radius: "1.25rem",
  light: {
    background: "oklch(1.0000 0 0)",
    foreground: "oklch(0.2095 0.0019 286.2304)",
    card: "oklch(0.9610 0.0029 264.5419)",
    "card-foreground": "oklch(0.2095 0.0019 286.2304)",
    popover: "oklch(0.9610 0.0029 264.5419)",
    "popover-foreground": "oklch(0.2095 0.0019 286.2304)",
    primary: "oklch(0.5334 0.2049 258.8101)",
    "primary-foreground": "oklch(1.0000 0 0)",
    secondary: "oklch(0.9250 0.0042 271.3671)",
    "secondary-foreground": "oklch(0.2095 0.0019 286.2304)",
    muted: "oklch(0.9250 0.0042 271.3671)",
    "muted-foreground": "oklch(0.4996 0.0083 268.4779)",
    accent: "oklch(0.9250 0.0042 271.3671)",
    "accent-foreground": "oklch(0.2095 0.0019 286.2304)",
    destructive: "oklch(0.6290 0.1902 23.0704)",
    "destructive-foreground": "oklch(1.0000 0 0)",
    border: "oklch(0.9610 0.0029 264.5419)",
    input: "oklch(0.8946 0.0042 271.3653)",
    ring: "oklch(0.5334 0.2049 258.8101)",
    "chart-1": "oklch(0.5334 0.2049 258.8101)",
    "chart-2": "oklch(0.6221 0.1726 40.1122)",
    "chart-3": "oklch(0.6212 0.1283 163.1147)",
    "chart-4": "oklch(0.6402 0.1361 73.3684)",
    "chart-5": "oklch(0.6224 0.1712 0.8378)",
    sidebar: "oklch(0.9610 0.0029 264.5419)",
    "sidebar-foreground": "oklch(0.2095 0.0019 286.2304)",
    "sidebar-primary": "oklch(0.5334 0.2049 258.8101)",
    "sidebar-primary-foreground": "oklch(1.0000 0 0)",
    "sidebar-accent": "oklch(0.9250 0.0042 271.3671)",
    "sidebar-accent-foreground": "oklch(0.2095 0.0019 286.2304)",
    "sidebar-border": "oklch(0.9610 0.0029 264.5419)",
    "sidebar-ring": "oklch(0.5334 0.2049 258.8101)",
    ...FONTS_GEIST,
    ...SHADOWS_FLAT,
    "tracking-normal": "0em",
  },
  dark: {
    background: "oklch(0.2095 0.0019 286.2304)",
    foreground: "oklch(1.0000 0 0)",
    card: "oklch(0.2807 0.0039 264.5029)",
    "card-foreground": "oklch(1.0000 0 0)",
    popover: "oklch(0.2807 0.0039 264.5029)",
    "popover-foreground": "oklch(1.0000 0 0)",
    primary: "oklch(0.6586 0.1697 256.7129)",
    "primary-foreground": "oklch(0 0 0)",
    secondary: "oklch(0.3254 0.0017 286.3025)",
    "secondary-foreground": "oklch(1.0000 0 0)",
    muted: "oklch(0.3254 0.0017 286.3025)",
    "muted-foreground": "oklch(0.6894 0.0076 268.5199)",
    accent: "oklch(0.3254 0.0017 286.3025)",
    "accent-foreground": "oklch(1.0000 0 0)",
    destructive: "oklch(0.6897 0.1998 23.9818)",
    "destructive-foreground": "oklch(1.0000 0 0)",
    border: "oklch(0.2807 0.0039 264.5029)",
    input: "oklch(0.3826 0.0036 264.5200)",
    ring: "oklch(0.6586 0.1697 256.7129)",
    "chart-1": "oklch(0.6586 0.1697 256.7129)",
    "chart-2": "oklch(0.6221 0.1726 40.1122)",
    "chart-3": "oklch(0.6212 0.1283 163.1147)",
    "chart-4": "oklch(0.6699 0.1425 73.2269)",
    "chart-5": "oklch(0.6224 0.1712 0.8378)",
    sidebar: "oklch(0.2807 0.0039 264.5029)",
    "sidebar-foreground": "oklch(1.0000 0 0)",
    "sidebar-primary": "oklch(0.6586 0.1697 256.7129)",
    "sidebar-primary-foreground": "oklch(0 0 0)",
    "sidebar-accent": "oklch(0.3254 0.0017 286.3025)",
    "sidebar-accent-foreground": "oklch(1.0000 0 0)",
    "sidebar-border": "oklch(0.2807 0.0039 264.5029)",
    "sidebar-ring": "oklch(0.6586 0.1697 256.7129)",
    ...FONTS_GEIST,
    ...SHADOWS_FLAT,
  },
};

/** tweakcn "cute" — https://tweakcn.com/r/themes/cmt9f941p000104l8e5f21j56 */
const CUTE: ThemePalette = {
  id: "cute",
  label: "Cute",
  source: "https://tweakcn.com/r/themes/cmt9f941p000104l8e5f21j56",
  radius: "4px",
  light: {
    background: "oklch(0.9940 0 0)",
    foreground: "oklch(0.2178 0 0)",
    card: "oklch(0.9696 0.0026 106.4486)",
    "card-foreground": "oklch(0.2178 0 0)",
    popover: "oklch(0.9940 0 0)",
    "popover-foreground": "oklch(0.2178 0 0)",
    primary: "oklch(0.5848 0.2288 7.8042)",
    "primary-foreground": "oklch(0.9940 0 0)",
    secondary: "oklch(0.9696 0.0026 106.4486)",
    "secondary-foreground": "oklch(0.2178 0 0)",
    muted: "oklch(0.9696 0.0026 106.4486)",
    "muted-foreground": "oklch(0.4640 0 0)",
    accent: "oklch(0.9696 0.0026 106.4486)",
    "accent-foreground": "oklch(0.5848 0.2288 7.8042)",
    destructive: "oklch(0.5737 0.2238 28.1631)",
    "destructive-foreground": "oklch(0.9940 0 0)",
    border: "oklch(0.9370 0 0)",
    input: "oklch(0.9940 0 0)",
    ring: "oklch(0.5848 0.2288 7.8042)",
    "chart-1": "oklch(0.5848 0.2288 7.8042)",
    "chart-2": "oklch(0.5109 0.0861 186.3914)",
    "chart-3": "oklch(0.5553 0.1455 48.9975)",
    "chart-4": "oklch(0.4907 0.2412 292.5809)",
    "chart-5": "oklch(0.5081 0.1049 165.6121)",
    sidebar: "oklch(0.9940 0 0)",
    "sidebar-foreground": "oklch(0.4640 0 0)",
    "sidebar-primary": "oklch(0.5848 0.2288 7.8042)",
    "sidebar-primary-foreground": "oklch(0.9940 0 0)",
    "sidebar-accent": "oklch(0.9696 0.0026 106.4486)",
    "sidebar-accent-foreground": "oklch(0.5848 0.2288 7.8042)",
    "sidebar-border": "oklch(0.9370 0 0)",
    "sidebar-ring": "oklch(0.5848 0.2288 7.8042)",
    "font-sans": "Gloria Hallelujah, cursive",
    "font-serif": "JetBrains Mono, ui-monospace, monospace",
    "font-mono": "JetBrains Mono, ui-monospace, monospace",
    "shadow-color": "0 0 0",
    "shadow-opacity": "0.01",
    "shadow-blur": "2px",
    "shadow-spread": "0px",
    "shadow-offset-x": "0px",
    "shadow-offset-y": "1px",
    "letter-spacing": "-0.01em",
    spacing: "0.25rem",
    "shadow-2xs": "0px 1px 2px 0px hsl(0 0 0 / 0.01)",
    "shadow-xs": "0px 1px 2px 0px hsl(0 0 0 / 0.01)",
    "shadow-sm": "0px 1px 2px 0px hsl(0 0 0 / 0.01), 0px 1px 2px -1px hsl(0 0 0 / 0.01)",
    shadow: "0px 1px 2px 0px hsl(0 0 0 / 0.01), 0px 1px 2px -1px hsl(0 0 0 / 0.01)",
    "shadow-md": "0px 1px 2px 0px hsl(0 0 0 / 0.01), 0px 2px 4px -1px hsl(0 0 0 / 0.01)",
    "shadow-lg": "0px 1px 2px 0px hsl(0 0 0 / 0.01), 0px 4px 6px -1px hsl(0 0 0 / 0.01)",
    "shadow-xl": "0px 1px 2px 0px hsl(0 0 0 / 0.01), 0px 8px 10px -1px hsl(0 0 0 / 0.01)",
    "shadow-2xl": "0px 1px 2px 0px hsl(0 0 0 / 0.03)",
    "tracking-normal": "-0.01em",
  },
  dark: {
    background: "oklch(0.1944 0.0053 39.3602)",
    foreground: "oklch(0.9639 0.0076 61.4527)",
    card: "oklch(0.2346 0.0073 48.3926)",
    "card-foreground": "oklch(0.9639 0.0076 61.4527)",
    popover: "oklch(0.2346 0.0073 48.3926)",
    "popover-foreground": "oklch(0.9639 0.0076 61.4527)",
    primary: "oklch(0.8469 0.0920 355.6303)",
    "primary-foreground": "oklch(0.1944 0.0053 39.3602)",
    secondary: "oklch(0.2346 0.0073 48.3926)",
    "secondary-foreground": "oklch(0.9639 0.0076 61.4527)",
    muted: "oklch(0.2346 0.0073 48.3926)",
    "muted-foreground": "oklch(0.7768 0.0135 48.5440)",
    accent: "oklch(0.3214 0.0739 357.9727)",
    "accent-foreground": "oklch(0.6747 0.2260 3.4499)",
    destructive: "oklch(0.6730 0.2146 25.0397)",
    "destructive-foreground": "oklch(0.9639 0.0076 61.4527)",
    border: "oklch(0.3576 0.0157 43.0512)",
    input: "oklch(0.1944 0.0053 39.3602)",
    ring: "oklch(0.6580 0.2062 2.7269)",
    "chart-1": "oklch(0.6580 0.2062 2.7269)",
    "chart-2": "oklch(0.7038 0.1230 182.5025)",
    "chart-3": "oklch(0.7686 0.1647 70.0804)",
    "chart-4": "oklch(0.7090 0.1592 293.5412)",
    "chart-5": "oklch(0.6959 0.1491 162.4796)",
    sidebar: "oklch(0.1944 0.0053 39.3602)",
    "sidebar-foreground": "oklch(0.7768 0.0135 48.5440)",
    "sidebar-primary": "oklch(0.6580 0.2062 2.7269)",
    "sidebar-primary-foreground": "oklch(0.1944 0.0053 39.3602)",
    "sidebar-accent": "oklch(0.2346 0.0073 48.3926)",
    "sidebar-accent-foreground": "oklch(0.6580 0.2062 2.7269)",
    "sidebar-border": "oklch(0.3576 0.0157 43.0512)",
    "sidebar-ring": "oklch(0.6580 0.2062 2.7269)",
    "font-sans": "Gloria Hallelujah, cursive",
    "font-serif": "JetBrains Mono, ui-monospace, monospace",
    "font-mono": "JetBrains Mono, ui-monospace, monospace",
    "shadow-color": "0 0 0",
    "shadow-opacity": "0.1",
    "shadow-blur": "6px",
    "shadow-spread": "0px",
    "shadow-offset-x": "0px",
    "shadow-offset-y": "2px",
    "letter-spacing": "-0.01em",
    spacing: "0.25rem",
    "shadow-2xs": "0px 2px 6px 0px hsl(0 0 0 / 0.05)",
    "shadow-xs": "0px 2px 6px 0px hsl(0 0 0 / 0.05)",
    "shadow-sm": "0px 2px 6px 0px hsl(0 0 0 / 0.10), 0px 1px 2px -1px hsl(0 0 0 / 0.10)",
    shadow: "0px 2px 6px 0px hsl(0 0 0 / 0.10), 0px 1px 2px -1px hsl(0 0 0 / 0.10)",
    "shadow-md": "0px 2px 6px 0px hsl(0 0 0 / 0.10), 0px 2px 4px -1px hsl(0 0 0 / 0.10)",
    "shadow-lg": "0px 2px 6px 0px hsl(0 0 0 / 0.10), 0px 4px 6px -1px hsl(0 0 0 / 0.10)",
    "shadow-xl": "0px 2px 6px 0px hsl(0 0 0 / 0.10), 0px 8px 10px -1px hsl(0 0 0 / 0.10)",
    "shadow-2xl": "0px 2px 6px 0px hsl(0 0 0 / 0.25)",
  },
};

/** Default palette. Must stay first: `allPalettes[0]` is the fallback everywhere. */
const DEFAULT_PALETTE_ID = "tokyo-night";

const BUNDLED: ThemePalette[] = [TOKYO_NIGHT, VEKIS, CLAUDE_PLUS, MONO, MUSE, CUTE];

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
let currentId = DEFAULT_PALETTE_ID;
if (typeof window !== "undefined") {
  try {
    const stored = window.localStorage.getItem(PALETTE_KEY);
    if (stored && allPalettes.some((p) => p.id === stored)) currentId = stored;
  } catch {
    /* private mode — the default palette stands */
  }
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
// React bindings

export function usePalettes(): ThemePalette[] {
  return useSyncExternalStore(subscribePalettes, getPalettes, getPalettes);
}

export function usePaletteId(): string {
  return useSyncExternalStore(subscribePalettes, getPaletteId, getPaletteId);
}
