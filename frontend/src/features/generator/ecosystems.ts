/**
 * Civitai sdcpp ecosystems exposed by the Generator panel.
 *
 * Values are transcribed from the official imageGen OpenAPI spec
 * (orchestration.civitai.com/v2/consumer/recipes/imageGen/openapi.yaml —
 * the sdcpp engine's ecosystem discriminator mapping + per-ecosystem
 * Create-input defaults). Ecosystem ids are EXACT wire values; defaults are
 * the spec's, so the panel never sends values outside the documented range.
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

/** Aspect presets anchored on a square base — 1:1, 16:9, 9:16, 3:4, 4:3,
 *  all near ~1 MP for the base size (the docs' well-behaved-dimension
 *  guidance). */
const LANDSCAPE = (base: number) => {
  const wide = Math.round((base * 16) / 9);
  const tall = Math.round((base * 9) / 16);
  return [
    { label: `${base}×${base}`, width: base, height: base },
    { label: `${wide}×${tall}`, width: wide, height: tall },
    { label: `${tall}×${wide}`, width: tall, height: wide },
    { label: `${Math.round((base * 3) / 4)}×${base}`, width: Math.round((base * 3) / 4), height: base },
    { label: `${base}×${Math.round((base * 3) / 4)}`, width: base, height: Math.round((base * 3) / 4) },
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
    sizes: LANDSCAPE(1024),
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
    sizes: LANDSCAPE(512),
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
    sizes: LANDSCAPE(1024),
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
    sizes: LANDSCAPE(1024),
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
    sizes: LANDSCAPE(512),
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
    sizes: LANDSCAPE(1024),
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
    sizes: LANDSCAPE(1024),
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
    sizes: LANDSCAPE(1024),
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
    sizes: LANDSCAPE(1024),
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
    sizes: LANDSCAPE(1024),
  },
];

/** Frontend mirror of the backend's `civitai::ImageGenParams` (camelCase). */
export interface GenParams {
  ecosystem: string;
  /** Recipe engine; omit for the default sdcpp engine. */
  engine?: "wan" | "seedream" | "grok";
  /** Generation workflow; omit = `txt2img` (backend default). */
  workflow?: string;
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
 * Workflow registry — frontend mirror of `civitai::registry` (image-only).
 * `txt2img` runs everywhere; `img2img` needs a source image, which only the
 * sdcpp `createImage` shape takes. Single source of truth for the panel's
 * workflow ↔ ecosystem coherence (civitai's `selectorCoherence`).
 */
export interface WorkflowConfig {
  id: string;
  label: string;
  ecosystems: string[];
}

const SDCPP_IDS = ECOSYSTEMS.filter((e) => !e.engine).map((e) => e.id);

export const WORKFLOWS: WorkflowConfig[] = [
  { id: "txt2img", label: "Teks → Gambar", ecosystems: ECOSYSTEMS.map((e) => e.id) },
  { id: "img2img", label: "Gambar → Gambar", ecosystems: SDCPP_IDS },
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
