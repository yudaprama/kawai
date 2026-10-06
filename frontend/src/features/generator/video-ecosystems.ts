/**
 * Civitai video ecosystems — Generator panel (video mode).
 *
 * Mirror of the Rust registry (`crates/integrations/civitai/src/registry.rs`,
 * video section). Phase-1 engine enums (seedance/veo3/kling/minimax/wan)
 * were validated LIVE against `POST /v2/consumer/workflows?whatif=true`
 * (free) on 2026-10-05; phase-2 engines (flux3/grok/vidu/hunyuan) are
 * transcribed from civitai's own orchestrator handlers and marked
 * live-pending — the panel's whatif pre-flight validates every pick before
 * any spend regardless. The Rust side re-validates before any network call.
 *
 * Sora is absent: the live orchestrator retired that engine. LTX is deferred
 * (phase 3): its wire takes width/height PIXELS from per-resolution tables
 * plus Distilled/Sulphur model variants.
 */

export type VideoWorkflowId = "txt2vid" | "img2vid" | "img2vid:ref2vid" | "vid2vid:edit";

export interface VideoEcosystemConfig {
  /** Registry key (Rust `VideoEcosystem.key`). */
  id: string;
  label: string;
  /** Wire engine for the default model. */
  engine: string;
  /** Model chips: `(key, label)` — empty key = the ecosystem default. */
  models: Array<{ key: string; label: string }>;
  workflows: VideoWorkflowId[];
  /** Discrete duration chips; when absent the duration is a slider. */
  durationChoices?: number[];
  durationMin: number;
  durationMax: number;
  /** Resolution chips; empty = the engine takes no resolution. */
  resolutions: string[];
  /** Aspect-ratio chips — text-driven workflows only. */
  aspectRatios: string[];
  /** `generateAudio` exists — per-model (kling v3, vidu q3). */
  audio: boolean;
  /** `negativePrompt` accepted (kling legacy only within its eco). */
  negativePrompt: boolean;
  /** img2vid frame slots for the default model (1 = single, 2 = first/last). */
  maxFrames: 1 | 2;
  /** ref2vid reference cap; 0 = unsupported. */
  refMax: number;
  /** Prompt-style chips (vidu q1). */
  styles: string[];
  /** Movement-amplitude chips (vidu q1). */
  movements: string[];
  /** Inclusive steps range (hunyuan). */
  stepsRange?: { min: number; max: number; default: number };
  /** cfgScale range + default (hunyuan 1–10 def 6; kling legacy 0.1–1). */
  cfgRange?: { min: number; max: number; default: number };
  /** Draft quality tier offered (flux3 pins 720p; vidu q3 turbo). */
  draft: boolean;
  /** Prompt-enhancer toggle offered (defaults ON on the wire). */
  promptEnhancer: boolean;
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
    workflows: ["txt2vid", "img2vid", "img2vid:ref2vid"],
    durationMin: 4,
    durationMax: 15,
    resolutions: ["2K"],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    audio: false,
    negativePrompt: false,
    maxFrames: 2,
    refMax: 9,
    styles: [],
    movements: [],
    draft: false,
    promptEnhancer: false,
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
    workflows: ["txt2vid", "img2vid", "img2vid:ref2vid"],
    durationMin: 4,
    durationMax: 15,
    resolutions: ["480p", "720p"],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    audio: true,
    negativePrompt: false,
    maxFrames: 1,
    refMax: 9,
    styles: [],
    movements: [],
    draft: false,
    promptEnhancer: false,
    gradient: "from-violet-500 to-purple-600",
    note: "ByteDance — cheap tier (v2-mini ≈ 490 buzz / 5s)",
  },
  {
    id: "veo3",
    label: "Veo 3",
    engine: "veo3",
    models: [],
    workflows: ["txt2vid", "img2vid", "img2vid:ref2vid"],
    durationChoices: [4, 6, 8],
    durationMin: 4,
    durationMax: 8,
    resolutions: [],
    aspectRatios: ["16:9", "9:16", "1:1"],
    audio: true,
    negativePrompt: true,
    maxFrames: 1,
    refMax: 3,
    styles: [],
    movements: [],
    draft: false,
    promptEnhancer: false,
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
    workflows: ["txt2vid", "img2vid", "img2vid:ref2vid"],
    durationChoices: [5, 10],
    durationMin: 5,
    durationMax: 10,
    resolutions: [],
    aspectRatios: ["16:9", "9:16", "1:1"],
    audio: true,
    negativePrompt: true,
    maxFrames: 1,
    refMax: 0,
    styles: [],
    movements: [],
    draft: false,
    promptEnhancer: true,
    gradient: "from-pink-500 to-rose-600",
    note: "Legacy 5/10s enum — V3 slider 5–15s + 2 frame slots + refs",
  },
  {
    id: "wan",
    label: "Wan 2.5",
    engine: "wan",
    models: [{ key: "v2.5", label: "V2.5" }],
    workflows: ["txt2vid", "img2vid"],
    durationChoices: [5, 10],
    durationMin: 5,
    durationMax: 10,
    resolutions: ["480p", "720p", "1080p"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4"],
    audio: false,
    negativePrompt: true,
    maxFrames: 1,
    refMax: 0,
    styles: [],
    movements: [],
    draft: false,
    promptEnhancer: false,
    gradient: "from-emerald-500 to-teal-600",
    note: "Alibaba fal lane — cheap (≈500 buzz / 5s)",
  },
  {
    id: "flux3",
    label: "Flux 3 Video",
    engine: "flux",
    models: [],
    workflows: ["txt2vid", "img2vid"],
    durationMin: 4,
    durationMax: 20,
    resolutions: ["720p", "1080p"],
    aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
    audio: true,
    negativePrompt: false,
    maxFrames: 2,
    refMax: 0,
    styles: [],
    movements: [],
    draft: true,
    promptEnhancer: false,
    gradient: "from-slate-500 to-zinc-700",
    note: "Black Forest Labs — draft mode, first/last frame ops (live-pending)",
  },
  {
    id: "grok",
    label: "Grok Imagine",
    engine: "grok",
    models: [
      { key: "v1.5", label: "V1.5" },
      { key: "v1.0", label: "V1.0 Edit" },
    ],
    workflows: ["txt2vid", "img2vid", "img2vid:ref2vid", "vid2vid:edit"],
    durationMin: 6,
    durationMax: 15,
    resolutions: ["480p", "720p", "1080p"],
    aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"],
    audio: false,
    negativePrompt: false,
    maxFrames: 1,
    refMax: 7,
    styles: [],
    movements: [],
    draft: false,
    promptEnhancer: false,
    gradient: "from-neutral-600 to-neutral-800",
    note: "xAI v1.5 — s/d 1080p, 7 referensi (live-pending)",
  },
  {
    id: "vidu",
    label: "Vidu",
    engine: "vidu",
    models: [
      { key: "q1", label: "Q1" },
      { key: "q3", label: "Q3" },
    ],
    workflows: ["txt2vid", "img2vid", "img2vid:ref2vid"],
    durationMin: 1,
    durationMax: 16,
    resolutions: ["360p", "540p", "720p", "1080p"],
    aspectRatios: ["16:9", "1:1", "9:16", "4:3", "3:4"],
    audio: true,
    negativePrompt: false,
    maxFrames: 2,
    refMax: 7,
    styles: ["general", "anime"],
    movements: ["auto", "small", "medium", "large"],
    draft: true,
    promptEnhancer: true,
    gradient: "from-lime-500 to-green-600",
    note: "Q1 style/movement — Q3 resolusi 360p–1080p (live-pending)",
  },
  {
    id: "ltx",
    label: "LTX Video",
    engine: "ltx2.3",
    models: [
      { key: "v2.3", label: "2.3 Dev" },
      { key: "v2.3-distilled", label: "2.3 Distilled" },
      { key: "v2.5", label: "2.5 Dev" },
      { key: "v2.5-distilled", label: "2.5 Distilled" },
    ],
    workflows: ["txt2vid", "img2vid"],
    durationMin: 3,
    durationMax: 20,
    resolutions: ["720p", "1080p"],
    aspectRatios: ["16:9", "3:2", "1:1", "2:3", "9:16"],
    audio: true,
    negativePrompt: true,
    maxFrames: 2,
    refMax: 0,
    styles: [],
    movements: [],
    stepsRange: { min: 10, max: 60, default: 30 },
    cfgRange: { min: 1, max: 10, default: 3 },
    draft: false,
    promptEnhancer: false,
    gradient: "from-fuchsia-500 to-pink-600",
    note: "Comfy lane — img2vid = first/last frame, distilled = cepat (live-pending)",
  },
  {
    id: "hunyuan",
    label: "Hunyuan Video",
    engine: "hunyuan",
    models: [],
    workflows: ["txt2vid"],
    durationChoices: [3, 5],
    durationMin: 3,
    durationMax: 5,
    resolutions: [],
    aspectRatios: ["16:9", "3:2", "1:1", "2:3", "9:16"],
    audio: false,
    negativePrompt: false,
    maxFrames: 1,
    refMax: 0,
    styles: [],
    movements: [],
    draft: false,
    promptEnhancer: false,
    gradient: "from-sky-600 to-indigo-700",
    note: "Tencent 480p — cfg/steps penuh, LoRA di wire (live-pending)",
  },
];

export const DEFAULT_VIDEO_ECOSYSTEM = "minimax";

export function videoEcosystem(id: string): VideoEcosystemConfig {
  return VIDEO_ECOSYSTEMS.find((e) => e.id === id) ?? VIDEO_ECOSYSTEMS[0];
}

/** Kling v3 swaps the engine AND unlocks slots/refs — the per-model split
 *  the panel must honour (mirrors Rust `video_caps`). */
export function isKlingV3(ecoId: string, modelKey: string): boolean {
  return ecoId === "kling" && modelKey === "v3";
}

export function videoMaxFrames(ecoId: string, modelKey: string): 1 | 2 {
  if (isKlingV3(ecoId, modelKey)) return 2;
  return videoEcosystem(ecoId).maxFrames;
}

export function videoRefMax(ecoId: string, modelKey: string): number {
  if (ecoId === "kling") return isKlingV3(ecoId, modelKey) ? 7 : 0;
  return videoEcosystem(ecoId).refMax;
}

export function videoResolutions(ecoId: string, modelKey: string): string[] {
  // vidu q1 takes no resolution field (Rust caps).
  if (ecoId === "vidu" && modelKey !== "q3") return [];
  // grok v1.0 edit lane serves 480p/720p only (Rust caps).
  if (ecoId === "grok" && modelKey === "v1.0") return ["480p", "720p"];
  return videoEcosystem(ecoId).resolutions;
}

/** The edit-video workflow applies (grok v1.0 lane only). */
export function videoHasEdit(ecoId: string, modelKey: string): boolean {
  return ecoId === "grok" && modelKey === "v1.0";
}

export function videoAspects(ecoId: string, modelKey: string): string[] {
  // vidu q1 narrows to the veo-style trio (Rust caps).
  if (ecoId === "vidu" && modelKey !== "q3") return ["16:9", "1:1", "9:16"];
  return videoEcosystem(ecoId).aspectRatios;
}

export function videoDurationChoices(ecoId: string, modelKey: string): number[] | null {
  if (isKlingV3(ecoId, modelKey)) return null; // slider 5–15
  const eco = videoEcosystem(ecoId);
  return eco.durationChoices ?? null;
}

export function videoDurationRange(ecoId: string, modelKey: string, resolution?: string): { min: number; max: number } {
  if (isKlingV3(ecoId, modelKey)) return { min: 5, max: 15 };
  const eco = videoEcosystem(ecoId);
  // LTX caps duration per resolution (720p → 20s, 1080p → 15s).
  if (ecoId === "ltx") return { min: 3, max: resolution === "1080p" ? 15 : 20 };
  return { min: eco.durationMin, max: eco.durationMax };
}

/** The engine takes no duration field (vidu q1 — Rust `duration_omitted`). */
export function videoDurationOmitted(ecoId: string, modelKey: string): boolean {
  return ecoId === "vidu" && modelKey !== "q3";
}

/** `generateAudio` applies (kling: v3 only; vidu: q3 only). */
export function videoHasAudio(ecoId: string, modelKey: string): boolean {
  const eco = videoEcosystem(ecoId);
  if (!eco.audio) return false;
  if (ecoId === "kling") return modelKey === "v3";
  if (ecoId === "vidu") return modelKey === "q3";
  return true;
}

/** `negativePrompt` applies (kling: legacy models only). */
export function videoHasNegative(ecoId: string, modelKey: string): boolean {
  const eco = videoEcosystem(ecoId);
  if (!eco.negativePrompt) return false;
  return ecoId !== "kling" || modelKey !== "v3";
}

/** A prompt-enhancer toggle is offered (kling: legacy only; vidu: q1 only). */
export function videoHasPromptEnhancer(ecoId: string, modelKey: string): boolean {
  const eco = videoEcosystem(ecoId);
  if (!eco.promptEnhancer) return false;
  if (ecoId === "kling") return modelKey !== "v3";
  if (ecoId === "vidu") return modelKey === "q1";
  return true;
}

/** Wire engine for an ecosystem + model pair (Rust `video_engine`). */
export function videoEngine(ecoId: string, modelKey: string): string {
  const eco = videoEcosystem(ecoId);
  if (!modelKey) return eco.engine;
  if (ecoId === "kling" && modelKey === "v3") return "kling-v3";
  if (ecoId === "vidu" && modelKey === "q3") return "vidu-q3";
  return eco.engine;
}
