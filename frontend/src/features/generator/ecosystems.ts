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
 *  well-behaved-dimension rule). Anchored on the ecosystem's base size. */
const SIZE_PRESETS = (base: number) => {
  const wide = Math.round((base * 16) / 9 / 16) * 16;
  const tall = Math.round((base * 3) / 2 / 16) * 16;
  return [
    { label: "1:1", width: base, height: base },
    { label: "3:2", width: tall, height: base },
    { label: "2:3", width: base, height: tall },
    { label: "16:9", width: wide, height: base },
    { label: "9:16", width: base, height: wide },
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

/** Frontend mirror of the backend's `civitai::ImageGenParams` (camelCase). */
export interface GenParams {
  ecosystem: string;
  /** Recipe engine; omit for the default sdcpp engine. */
  engine?: "wan" | "seedream" | "grok";
  /** Generation workflow; omit = `txt2img` (backend default). */
  workflow?: string;
  /** Source image (URL / data URL / base64) for image-input workflows
   *  (`img2img`, `img2img:upscale`) — passed to the recipe verbatim. */
  sourceImage?: string;
  /** Denoise strength for `img2img` (`createVariant`), 0–1; default 0.7. */
  strength?: number;
  /** Upscale passes (1–3, each doubles resolution) for the upscale-backed
   *  workflows (`txt2img:hires-fix`, `img2img:upscale`); default 1. */
  upscaleRepeats?: number;
  prompt: string;
  negativePrompt?: string;
  width: number;
  height: number;
  cfgScale?: number;
  steps?: number;
  quantity?: number;
  seed?: number;
  loras?: Array<{ air: string; strength: number }>;
  /** Checkpoint override (AIR URN) when the user picks a specific model. */
  diffuserModel?: string;
  /** sdcpp sampler display name (civitai's `samplers` list) —
   *  SD-family ecosystems only; translated to `sampleMethod`
   *  + `schedule` on the wire. */
  sampler?: string;
  /** Skip N CLIP layers (1–3, SD-family ecosystems only;
   *  the spec's SD graph defaults to 2). */
  clipSkip?: number;
}

export interface SavedImage {
  fileId: string;
  name: string;
}

/** Frontend mirror of `logic::civitai::SearchModelRow` — one row of the
 *  in-pane model browser grid. */
export interface SearchModelRow {
  modelId: number;
  versionId: number;
  name: string;
  creator: string | null;
  downloads: number | null;
  thumbsUp: number | null;
  baseModel: string | null;
  coverUrl: string | null;
  description: string | null;
  /** Up to 3 showcase images besides the cover. */
  exampleUrls: string[];
  /** `urn:air:{ecosystem}:{checkpoint|lora}:civitai:{model}@{version}` */
  airUrn: string;
}

/** Frontend mirror of `logic::civitai::SearchModelPage`. */
export interface SearchModelPage {
  rows: SearchModelRow[];
  nextCursor: string | null;
}

/**
 * Buzz cost estimate — the imageGen recipes' documented pricing shape:
 * `total = 8 × (W×H / 1024²) × (steps / 25) × quantity` (anchored on
 * 1024² / 25 steps). The API exposes no free pricing mode (whatif is
 * silently ignored — verified live), so this client-side approximation is
 * what the panel shows; defaults (steps 30) match the spec.
 */
export function estimateBuzz(params: { width: number; height: number; steps?: number; quantity?: number }): number {
  const steps = params.steps !== undefined && params.steps > 0 ? params.steps : 30;
  const quantity = params.quantity ?? 1;
  return 8 * ((params.width * params.height) / (1024 * 1024)) * (steps / 25) * quantity;
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
