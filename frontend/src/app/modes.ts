import type { TranslationKey } from "@/lib/i18n";

/**
 * The app's top-level surfaces — the `ModeBar` row every screen carries.
 *
 * One axis, not two: `text` IS the Workbench (goal composer + deliverable),
 * and the other four are the media generation lanes. Assets (Wiki, Wallet,
 * Top Up, Connections…) are a separate, deeper layer reached from the account
 * cluster — they are deliberately NOT modes, so the bar stays five wide
 * instead of fourteen.
 */
export const APP_MODES = ["text", "image", "video", "audio", "model3d"] as const;
export type AppMode = (typeof APP_MODES)[number];

/** The four generation lanes — `AppMode` minus the Workbench. */
export const MEDIA_MODES = ["image", "video", "audio", "model3d"] as const;
export type MediaMode = (typeof MEDIA_MODES)[number];

export const isMediaMode = (mode: AppMode): mode is MediaMode => mode !== "text";

/** Lucide icon per mode. */
export const MODE_ICON: Record<AppMode, string> = {
  text: "type",
  image: "image",
  video: "video",
  audio: "music",
  model3d: "box",
};

/**
 * Display name per mode. The `audio` lane generates music AND sound effects
 * (sonilo's `soundEffect` operation), so the bar says "Audio" while the lane
 * keeps its `music` id — that id is baked into its localStorage keys and op
 * names, and renaming it would orphan every saved result.
 */
export const MODE_LABEL: Record<AppMode, TranslationKey> = {
  text: "modeBar.text",
  image: "modeBar.image",
  video: "modeBar.video",
  audio: "modeBar.audio",
  model3d: "modeBar.model3d",
};
