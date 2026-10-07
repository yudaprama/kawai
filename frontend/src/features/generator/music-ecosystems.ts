/**
 * Civitai music ecosystems — Generator panel (music mode).
 *
 * Mirror of the Rust registry (civitai music section). Prices in the notes
 * were validated LIVE against the free whatif (`civitai_music_cost`) on
 * 2026-10-06; the Rust side re-validates every pick before any network
 * call, and the panel's whatif pre-flight surfaces mismatches before any
 * spend.
 */

export type MusicEcosystemId = "minimax-music3" | "yue2" | "sonilo" | "ace";

export type MusicMode = "simple" | "custom";

/** sonilo only: full music track vs short sound effect. */
export type MusicOperation = "music" | "soundEffect";

/** yue2 ABC score handling. */
export type MusicScoreMode = "full" | "melody" | "off";

/** ace variant (Rust `model`). */
export type MusicAceVariant = "xl-turbo" | "turbo" | "xl-sft" | "xl-base" | "base";

export interface MusicEcosystemConfig {
  /** Registry key (wire `ecosystem`). */
  id: MusicEcosystemId;
  label: string;
  /** Pinned wire model — civitai locks the resource row (modelLocked). */
  model: string;
  /** Drafting modes offered (sonilo is custom-only — no LLM drafting). */
  modes: MusicMode[];
  /** Operation chips — sonilo only. */
  operations: MusicOperation[];
  /** Per-operation duration bounds (seconds); key "" = the only operation. */
  duration: Record<string, { min: number; max: number; step: number; default: number }>;
  /** Prompt/caption hard cap (wire-validated). */
  promptMax: number;
  /** Tailwind gradient for the model tile (civitai-panel look). */
  gradient: string;
  note: string;
}

export const MUSIC_ECOSYSTEMS: MusicEcosystemConfig[] = [
  {
    id: "minimax-music3",
    label: "MiniMax Music 3",
    model: "MiniMax Music 3 v3.0",
    modes: ["simple", "custom"],
    operations: [],
    duration: { "": { min: 30, max: 300, step: 10, default: 60 } },
    promptMax: 2000,
    gradient: "from-rose-500 to-orange-400",
    note: "Lagu lengkap — caption + lirik. ≈45 Buzz / 60 detik",
  },
  {
    id: "yue2",
    label: "YuE2",
    model: "YuE2 v2",
    modes: ["simple", "custom"],
    operations: [],
    duration: { "": { min: 1, max: 360, step: 1, default: 120 } },
    promptMax: 2000,
    gradient: "from-violet-500 to-fuchsia-400",
    note: "Musik vokal open-source — caption + lirik + skor ABC. ≈35 Buzz / 120 detik",
  },
  {
    id: "sonilo",
    label: "Sonilo",
    model: "Sonilo V1.1",
    modes: ["custom"],
    operations: ["music", "soundEffect"],
    duration: {
      music: { min: 5, max: 360, step: 5, default: 60 },
      soundEffect: { min: 0.5, max: 180, step: 0.5, default: 8 },
    },
    promptMax: 2000,
    gradient: "from-sky-500 to-cyan-400",
    note: "Musik & sound effect — satu prompt. ≈176 Buzz / 60 detik, SFX ≈8",
  },
  {
    id: "ace",
    label: "ACE Audio",
    model: "ACE Audio 1.5",
    modes: ["simple", "custom"],
    operations: [],
    duration: { "": { min: 1, max: 190, step: 1, default: 60 } },
    promptMax: 1000,
    gradient: "from-emerald-500 to-lime-400",
    note: "Vokal + instrumen terkontrol — BPM, key, bobot. ≈16 Buzz / 60 detik",
  },
];

export const DEFAULT_MUSIC_ECOSYSTEM: MusicEcosystemId = "minimax-music3";

export const ACE_VARIANTS: Array<{ key: MusicAceVariant; label: string }> = [
  { key: "xl-turbo", label: "XL Turbo" },
  { key: "turbo", label: "Turbo" },
  { key: "xl-sft", label: "XL SFT" },
  { key: "xl-base", label: "XL Base" },
  { key: "base", label: "Base" },
];

export function musicEcosystem(id: string): MusicEcosystemConfig {
  return MUSIC_ECOSYSTEMS.find((e) => e.id === id) ?? MUSIC_ECOSYSTEMS[0];
}

/** Duration bounds for the ecosystem + operation ("" when it has one op). */
export function musicDurationRange(
  ecoId: string,
  operation: MusicOperation,
): { min: number; max: number; step: number; default: number } {
  return musicEcosystem(ecoId).duration[operation] ?? musicEcosystem(ecoId).duration[""];
}

/** ace steps range depends on the variant family (turbo vs base). */
export function aceStepsRange(variant: MusicAceVariant): { min: number; max: number; default: number } {
  return variant.includes("base") ? { min: 1, max: 100, default: 50 } : { min: 1, max: 20, default: 8 };
}

/** ace cfgScale default depends on the variant family. */
export function aceCfgDefault(variant: MusicAceVariant): number {
  return variant.includes("base") ? 4 : 1;
}
