/**
 * Civitai sdcpp ecosystems exposed by the Generator panel.
 *
 * Values are transcribed from the official imageGen OpenAPI spec
 * (orchestration.civitai.com/v2/consumer/recipes/imageGen/openapi.yaml —
 * the sdcpp engine's ecosystem discriminator mapping + per-ecosystem
 * Create-input defaults). Ecosystem ids are EXACT wire values; defaults are
 * the spec's, so the panel never sends values outside the documented range.
 *
 * The two Z-Image entries carry civitai's own form defaults instead
 * (`form-graph/generation/image/zimage.graph.ts` + `data-graph/generation/
 * z-image-graph.ts`): Turbo cfg 1 / steps 9, Base cfg 4 / steps 20, both on
 * the shared 1024² 1:1 bucket (Base's custom-size ceiling is 4 MP, Turbo's
 * ~1 MP) — the panel's SIZE_PRESETS chips stay well inside those ceilings.
 */
import type { ImageGenParams, SearchModelPage, SearchModelsArgs, SearchModelRow } from "@/generated/api-types";

export interface EcosystemConfig {
  /** Exact orchestrator ecosystem id (discriminator mapping key).
   *  Ignored for non-sdcpp engines (see `engine`). */
  id: string;
  label: string;
  /** Engine family — omit for the default sdcpp workers.
   *  Wire values mirror `civitai::ImageGenParams.engine`. */
  engine?: "wan" | "seedream" | "grok";
  note: string;
  /** Tailwind gradient classes for the model tile (civitai-panel look). */
  gradient: string;
  /** Spec defaults for this ecosystem's createImage input. */
  defaultWidth: number;
  defaultHeight: number;
  defaultCfgScale: number;
  defaultSteps: number;
  /** Well-behaved aspect presets near ~1 MP (docs guidance). */
  sizes: Array<{ label: string; width: number; height: number }>;
}

/** Aspect presets in civitai's chip language — clean ratio labels with the
 *  exact resolution each expands to (both sides %16, the recipe's
 *  well-behaved-dimension rule). Anchored on the ecosystem's base size:
 *  area stays ≈ base² and the ratio stays honest (floor to %16 so a
 *  rounded-up long edge can't drift the ratio — 16:9 lands on the
 *  standard 1344×768 bucket at base 1024, not 1824×1024). */
const SIZE_PRESETS = (base: number) => {
  const floor16 = (v: number) => Math.max(64, Math.floor(v / 16) * 16);
  const r16 = (rw: number, rh: number) => ({
    width: floor16(base * Math.sqrt(rw / rh)),
    height: floor16(base * Math.sqrt(rh / rw)),
  });
  return [
    { label: "1:1", width: base, height: base },
    { label: "3:2", ...r16(3, 2) },
    { label: "2:3", ...r16(2, 3) },
    { label: "16:9", ...r16(16, 9) },
    { label: "9:16", ...r16(9, 16) },
  ];
};

export const ECOSYSTEMS: EcosystemConfig[] = [
  {
    id: "anima",
    label: "Anima",
    gradient: "from-pink-500 to-purple-600",
    note: "Anime/illustration — cfg 4, steps 30 (spec defaults)",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 4,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(1024),
  },
  {
    id: "sdxl",
    label: "SDXL",
    gradient: "from-sky-500 to-cyan-500",
    note: "General purpose SDXL — spec default 512²",
    defaultWidth: 512,
    defaultHeight: 512,
    defaultCfgScale: 4,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(512),
  },
  {
    id: "flux1",
    label: "Flux 1",
    gradient: "from-amber-500 to-orange-600",
    note: "Flux.1 open weights via sdcpp workers",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 4,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(1024),
  },
  {
    id: "flux2Klein",
    label: "Flux 2 Klein",
    gradient: "from-emerald-500 to-teal-600",
    note: "Newer Flux family, spec default 1024²",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 4,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(1024),
  },
  {
    id: "sd1",
    label: "SD 1.5",
    gradient: "from-slate-500 to-gray-600",
    note: "Klasik SD 1.5 — spec default 512²",
    defaultWidth: 512,
    defaultHeight: 512,
    defaultCfgScale: 4,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(512),
  },
  {
    id: "flux2Dev",
    label: "Flux 2 Dev",
    gradient: "from-indigo-500 to-blue-600",
    note: "Flux 2 open weights, spec default 1024²",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 4,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(1024),
  },
  {
    id: "qwen",
    label: "Qwen",
    gradient: "from-violet-500 to-fuchsia-600",
    note: "Qwen-Image via sdcpp workers",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 4,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(1024),
  },
  {
    id: "zImageTurbo",
    label: "Z-Image Turbo",
    gradient: "from-lime-500 to-emerald-600",
    note: "Alibaba Z-Image Turbo — civitai default cfg 1, steps 9",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 1,
    defaultSteps: 9,
    sizes: SIZE_PRESETS(1024),
  },
  {
    id: "zImageBase",
    label: "Z-Image Base",
    gradient: "from-yellow-500 to-lime-600",
    note: "Z-Image Base — civitai default cfg 4, steps 20",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 4,
    defaultSteps: 20,
    sizes: SIZE_PRESETS(1024),
  },
  {
    id: "wan",
    label: "Wan Image",
    engine: "wan",
    gradient: "from-rose-500 to-red-700",
    note: "Wan Image — square_hd preset",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 3.5,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(1024),
  },
  {
    id: "seedream",
    label: "Seedream",
    engine: "seedream",
    gradient: "from-cyan-500 to-blue-700",
    note: "Seedream — guidance 2.5",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 2.5,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(1024),
  },
  {
    id: "grok",
    label: "Grok",
    engine: "grok",
    gradient: "from-zinc-500 to-zinc-800",
    note: "Grok v1.0 — aspect-ratio mode",
    defaultWidth: 1024,
    defaultHeight: 1024,
    defaultCfgScale: 4,
    defaultSteps: 30,
    sizes: SIZE_PRESETS(1024),
  },
];

/** civitai's generation-form sampler list (their `samplers`
 *  const, shared/constants/generation.constants.ts) — the
 *  sdcpp sampler dropdown. The backend maps each display
 *  name to a `sampleMethod` + `schedule` wire pair. */
export const SAMPLERS = ["Euler a", "Euler", "Heun", "LMS", "DDIM", "DPM++ 2M Karras", "DPM2"] as const;

/** The `civitai::ImageGenParams` wire contract — generated from
 *  the Rust struct (specta in-place derive in the civitai client
 *  crate) by `bun run generate:events`; never hand-edited.
 *
 *  Narrowing (the literal unions below) is the deliberate
 *  frontend-side guard the generated `string` lacks: the form only
 *  ever offers these engine/workflow values, so a typo fails at
 *  compile time instead of as a server 400. */
export type GenParams = ImageGenParams & {
  /** Recipe engine; omit for the default sdcpp engine. */
  engine?: "wan" | "seedream" | "grok" | null;
};
export type { ImageGenParams };

/** Search arguments + result rows for the in-pane model browser —
 *  generated from `kawai_api_types::*` by `bun run generate:events`;
 *  never hand-edited. Re-exported so existing import paths keep working. */
export type { SearchModelPage, SearchModelsArgs, SearchModelRow };

/** Stored generation result — the panel's localStorage job/results rows. */
/**
 * App-token twin of the Rust debit constant (`logic/civitai.rs::
 * TOKENS_PER_BUZZ`) — keep the two in sync. 1 Buzz = $0,001 × FX 20.000 =
 * Rp 20 → 2.000 tokens; ×1,2 margin → 2.400. The backend is authoritative
 * (ceil over the same conversion at submit); this only feeds the ≈ pill.
 */
export const TOKENS_PER_BUZZ = 2_400;

/**
 * Buzz cost estimate — the imageGen recipes' documented pricing shape:
 * `unit = 8 × (W×H / 1024²) × (steps / 25) × quantity` (anchored on
 * 1024² / 25 steps). The API exposes no free pricing mode (whatif is
 * silently ignored — verified live), so this client-side approximation is
 * what the panel shows; defaults (steps 30) match the spec.
 *
 * Mirrors `logic::civitai::image_buzz_estimate` including the upscale passes:
 * a pass doubles the resolution, so it is priced at the doubled dims (4× the
 * unit) — `txt2img:hires-fix` bills generation + passes and `img2img:upscale`
 * bills passes ONLY. Quoting generation alone would slip both workflows past
 * the client pre-check and land on the server's fail-closed gate after the
 * user already waited out the submit.
 */
export function estimateBuzz(params: {
  width: number;
  height: number;
  steps?: number;
  quantity?: number;
  workflow?: string;
  upscaleRepeats?: number;
}): number {
  const steps = params.steps !== undefined && params.steps > 0 ? params.steps : 30;
  const quantity = params.quantity ?? 1;
  const unit = 8 * ((params.width * params.height) / (1024 * 1024)) * (steps / 25) * quantity;
  const workflow = params.workflow ?? "txt2img";
  const generation = workflow === "img2img:upscale" ? 0 : unit;
  const passes =
    workflow === "txt2img:hires-fix" || workflow === "img2img:upscale" ? (params.upscaleRepeats ?? 1) * 4 * unit : 0;
  return generation + passes;
}

/**
 * Workflow registry — the panel's workflow ↔ ecosystem coherence, keyed
 * off civitai's own `workflowConfigs` (`src/shared/data-graph/generation/
 * config/workflows.ts`), where EVERY workflow carries its own
 * `ecosystemIds`:
 * - `txt2img` → `TXT2IMG_IDS` (every image ecosystem);
 * - `txt2img:hires-fix` / `img2img` → `SD_FAMILY_IDS` (SD1, SDXL, Pony,
 *   Illustrious, NoobAI — projected onto this panel's ecosystem set);
 * - `img2img:upscale` → standalone on civitai (its own Upscaler
 *   ecosystem); the consumer recipe is engine-agnostic, so it reuses the
 *   full image set (the panel hides the Eco selector for it anyway).
 *
 * Lists are clamped to what the consumer API can actually serve — the
 * backend `civitai::registry` is the capability superset that validates
 * every generate call (its `SDCPP`/engine rules still apply underneath).
 * Single source of truth for `selectorCoherence`-style retargeting.
 */
export interface WorkflowConfig {
  id: string;
  label: string;
  /** One-line description shown under the label in the dropdown
   *  (civitai's `workflowConfigs[].description`). */
  description: string;
  /** `"image"` = the workflow consumes a source image (upload required). */
  input: "text" | "image";
  /** The ONLY ecosystems listed for this workflow (civitai's
   *  `getEcosystemsForWorkflow`). */
  ecosystems: string[];
}

const ALL_IDS = ECOSYSTEMS.map((e) => e.id);
/** Civitai's `SD_FAMILY_IDS` = [SD1, SDXL, Pony, Illustrious, NoobAI],
 *  projected onto this panel's ecosystem set (same order → the default
 *  ecosystem for a SD-family workflow is `sd1`, civitai's `ecosystemIds[0]`). */
const SD_FAMILY_IDS = ["sd1", "sdxl"];

/** SD-family ecosystems — the only ones whose sdcpp input
 *  schema the spec confirms carries `sampleMethod`/`schedule`
 *  /`clipSkip` (Sd1/SdxlCreateImageGenInput). */
export function isSdFamily(ecosystemId: string): boolean {
  return SD_FAMILY_IDS.includes(ecosystemId);
}

/**
 * The civitai dropdown's image set, consumer-API edition. Face fix has no
 * consumer-API backing at all (only detection), so it is not offered.
 */
export const WORKFLOWS: WorkflowConfig[] = [
  {
    id: "txt2img",
    label: "Create Image",
    description: "Generate an AI image from text",
    input: "text",
    ecosystems: ALL_IDS,
  },
  {
    id: "txt2img:hires-fix",
    label: "Create + Hires Fix",
    description: "Generate with upscaling for higher detail",
    input: "text",
    ecosystems: SD_FAMILY_IDS,
  },
  {
    id: "img2img",
    label: "Image Variations",
    description: "Generate a variation of an existing image",
    input: "image",
    ecosystems: SD_FAMILY_IDS,
  },
  {
    id: "img2img:upscale",
    label: "Upscale",
    description: "Increase image resolution",
    input: "image",
    ecosystems: ALL_IDS,
  },
];

export const DEFAULT_WORKFLOW = "txt2img";

export function ecosystemsForWorkflow(workflowId: string): string[] {
  return WORKFLOWS.find((w) => w.id === workflowId)?.ecosystems ?? [];
}

export function defaultEcosystemForWorkflow(workflowId: string): string {
  return ecosystemsForWorkflow(workflowId)[0] ?? ECOSYSTEMS[0].id;
}

export function isWorkflowAvailable(workflowId: string, ecosystemId: string): boolean {
  return ecosystemsForWorkflow(workflowId).includes(ecosystemId);
}

/** Ecosystem unchanged when it serves the workflow, else the default. */
export function resolveCompatibleEcosystem(workflowId: string, ecosystemId: string): string {
  return isWorkflowAvailable(workflowId, ecosystemId) ? ecosystemId : defaultEcosystemForWorkflow(workflowId);
}

/** Workflow an ecosystem lands on when the current one can't serve it. */
export function targetWorkflowForEcosystem(ecosystemId: string): string {
  return WORKFLOWS.find((w) => w.ecosystems.includes(ecosystemId))?.id ?? DEFAULT_WORKFLOW;
}
