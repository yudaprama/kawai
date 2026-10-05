/**
 * Civitai video ecosystems — Generator panel (video mode).
 *
 * Mirror of the Rust registry (`crates/integrations/civitai/src/registry.rs`,
 * video section): every enum value here was validated LIVE against
 * `POST /v2/consumer/workflows?whatif=true` (free) on 2026-10-05, so the
 * panel never sends values outside what the orchestrator accepts. The Rust
 * side re-validates before any network call — this table exists so the FORM
 * renders the same choices without a round-trip.
 *
 * Sora is absent: the live orchestrator retired that engine ("Use another
 * videoGen engine such as veo3, kling-v3 or wan instead").
 */

export type VideoWorkflowId = "txt2vid" | "img2vid";

export interface VideoEcosystemConfig {
  /** Registry key (Rust `VideoEcosystem.key`). */
  id: string;
  label: string;
  /** Wire engine for the default model. */
  engine: string;
  /** Model chips: `(key, label)` — empty key = the ecosystem default. */
  models: Array<{ key: string; label: string }>;
  /** Discrete duration chips; when absent the duration is a slider. */
  durationChoices?: number[];
  durationMin: number;
  durationMax: number;
  /** Resolution chips; empty = the engine takes no resolution (veo3/kling). */
  resolutions: string[];
  /** Aspect-ratio chips — txt2vid only (img2vid derives from the frame). */
  aspectRatios: string[];
  /** `generateAudio` exists — kling only on model `v3`. */
  audio: boolean;
  /** `negativePrompt` accepted — kling only on legacy models. */
  negativePrompt: boolean;
  /** Tailwind gradient for the model tile (civitai-panel look). */
  gradient: string;
  note: string;
}

export const VIDEO_ECOSYSTEMS: VideoEcosystemConfig[] = [
  {
    id: "minimax",
    label: "MiniMax H3",
    engine: "minimax-h3",
    models: [],
    durationMin: 4,
    durationMax: 15,
    resolutions: ["2K"],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    audio: false,
    negativePrompt: false,
    gradient: "from-cyan-500 to-blue-600",
    note: "Default civitai — 2K pinned, first/last frame slots",
  },
  {
    id: "seedance",
    label: "Seedance",
    engine: "seedance",
    models: [
      { key: "v2", label: "V2" },
      { key: "v2-fast", label: "V2 Fast" },
      { key: "v2-mini", label: "V2 Mini" },
      { key: "v2.5", label: "V2.5" },
    ],
    durationMin: 4,
    durationMax: 15,
    resolutions: ["480p", "720p"],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    audio: true,
    negativePrompt: false,
    gradient: "from-violet-500 to-purple-600",
    note: "ByteDance — cheap tier (v2-mini ≈ 490 buzz / 5s)",
  },
  {
    id: "veo3",
    label: "Veo 3",
    engine: "veo3",
    models: [],
    durationChoices: [4, 6, 8],
    durationMin: 4,
    durationMax: 8,
    resolutions: [],
    aspectRatios: ["16:9", "9:16", "1:1"],
    audio: true,
    negativePrompt: true,
    gradient: "from-amber-500 to-orange-600",
    note: "Google — fast/standard toggle, audio native (≈1000 buzz / 4s)",
  },
  {
    id: "kling",
    label: "Kling",
    engine: "kling",
    models: [
      { key: "", label: "V1.6" },
      { key: "v2", label: "V2" },
      { key: "v2.5-turbo", label: "V2.5 Turbo" },
      { key: "v3", label: "V3" },
    ],
    durationChoices: [5, 10],
    durationMin: 5,
    durationMax: 10,
    resolutions: [],
    aspectRatios: ["16:9", "9:16", "1:1"],
    audio: true,
    negativePrompt: true,
    gradient: "from-pink-500 to-rose-600",
    note: "Legacy 5/10s enum — V3 slider 5–15s + audio",
  },
  {
    id: "wan",
    label: "Wan 2.5",
    engine: "wan",
    models: [{ key: "v2.5", label: "V2.5" }],
    durationChoices: [5, 10],
    durationMin: 5,
    durationMax: 10,
    resolutions: ["480p", "720p", "1080p"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    audio: false,
    negativePrompt: true,
    gradient: "from-emerald-500 to-teal-600",
    note: "Alibaba fal lane — cheap (≈500 buzz / 5s)",
  },
];

export const DEFAULT_VIDEO_ECOSYSTEM = "minimax";

export function videoEcosystem(id: string): VideoEcosystemConfig {
  return VIDEO_ECOSYSTEMS.find((e) => e.id === id) ?? VIDEO_ECOSYSTEMS[0];
}

/** Kling v3 swaps the engine AND the duration rule — the one per-model
 *  split the panel must honour (mirrors Rust `video_duration_set`). */
export function isKlingV3(ecoId: string, modelKey: string): boolean {
  return ecoId === "kling" && modelKey === "v3";
}

export function videoDurationChoices(ecoId: string, modelKey: string): number[] | null {
  if (isKlingV3(ecoId, modelKey)) return null; // slider 5–15
  const eco = videoEcosystem(ecoId);
  return eco.durationChoices ?? null;
}

export function videoDurationRange(ecoId: string, modelKey: string): { min: number; max: number } {
  if (isKlingV3(ecoId, modelKey)) return { min: 5, max: 15 };
  const eco = videoEcosystem(ecoId);
  return { min: eco.durationMin, max: eco.durationMax };
}

/** `generateAudio` applies (kling: v3 only — mirrors Rust `video_has_audio`). */
export function videoHasAudio(ecoId: string, modelKey: string): boolean {
  const eco = videoEcosystem(ecoId);
  if (!eco.audio) return false;
  return ecoId !== "kling" || modelKey === "v3";
}

/** `negativePrompt` applies (kling: legacy only — Rust `video_has_negative`). */
export function videoHasNegative(ecoId: string, modelKey: string): boolean {
  const eco = videoEcosystem(ecoId);
  if (!eco.negativePrompt) return false;
  return ecoId !== "kling" || modelKey !== "v3";
}

/** Wire engine for an ecosystem + model pair (Rust `video_engine`). */
export function videoEngine(ecoId: string, modelKey: string): string {
  const eco = videoEcosystem(ecoId);
  if (!modelKey) return eco.engine;
  if (ecoId === "kling" && modelKey === "v3") return "kling-v3";
  return eco.engine;
}
