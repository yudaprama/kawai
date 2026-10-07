/**
 * Civitai 3D-model ecosystems — Generator panel (3D mode).
 *
 * Mirror of the Rust registry (civitai 3D section) — every engine rides the
 * same `polyGen` orchestrator step; the Eco pick decides the step input
 * shape. The Rust side re-validates every pick before any network call,
 * and the panel's whatif pre-flight surfaces mismatches before any spend.
 */

export type Model3dEcosystemId = "meshy" | "tripo" | "trellis2" | "pixal3d" | "hunyuan3d";

/** meshy only: the other engines are image-to-3D only. */
export type Model3dProcess = "textTo3D" | "imageTo3D";

export interface Model3dEcosystemConfig {
  id: Model3dEcosystemId;
  label: string;
  gradient: string;
  note: string;
  processes: Model3dProcess[];
  /** meshy textTo3D ceiling; hunyuan shares the 600-char hint cap. */
  promptMax: number;
  /** hunyuan3D only: pinned modelVersion picks. */
  models: Array<{ key: string; label: string }>;
}

export const MODEL3D_ECOSYSTEMS: Model3dEcosystemConfig[] = [
  {
    id: "meshy",
    label: "Meshy v6",
    gradient: "from-violet-500 to-fuchsia-500",
    note: "Text/Image → 3D · quad/quad · rig + animasi",
    processes: ["textTo3D", "imageTo3D"],
    promptMax: 600,
    models: [],
  },
  {
    id: "tripo",
    label: "Tripo",
    gradient: "from-sky-500 to-cyan-400",
    note: "Image → 3D · texture no/standard/HD · face limit",
    processes: ["imageTo3D"],
    promptMax: 0,
    models: [],
  },
  {
    id: "trellis2",
    label: "Trellis.2",
    gradient: "from-emerald-500 to-teal-400",
    note: "Image → 3D via Comfy · texture/remesh/PBR",
    processes: ["imageTo3D"],
    promptMax: 0,
    models: [],
  },
  {
    id: "pixal3d",
    label: "Pixal3D",
    gradient: "from-amber-500 to-orange-400",
    note: "Image → 3D · varian Trellis.2 via Comfy",
    processes: ["imageTo3D"],
    promptMax: 0,
    models: [],
  },
  {
    id: "hunyuan3d",
    label: "Hunyuan3D",
    gradient: "from-blue-600 to-indigo-500",
    note: "Image → 3D via Comfy · v2 / v2.1 / v2-mini",
    processes: ["imageTo3D"],
    promptMax: 600,
    models: [
      { key: "v2", label: "V2" },
      { key: "v2.1", label: "V2.1" },
      { key: "v2-mini", label: "V2 Mini" },
    ],
  },
];

export const DEFAULT_MODEL3D_ECOSYSTEM: Model3dEcosystemId = "meshy";

/** meshy shared bounds (polygen.schema.ts). */
export const MESHY_POLYCOUNT = { min: 100, max: 300_000, default: 30_000, step: 100 };
/** tripo faceLimit bounds. */
export const TRIPO_FACE_LIMIT = { min: 1_000, max: 500_000, default: 100_000, step: 1_000 };
/** hunyuan3D sampler bounds. */
export const HUNYUAN_STEPS = { min: 1, max: 100, default: 30 };
export const HUNYUAN_CFG = { min: 0, max: 20, default: 5, step: 0.5 };
export const HUNYUAN_OCTREE = { min: 64, max: 512, default: 256, step: 64 };

export function model3dEcosystem(id: string): Model3dEcosystemConfig {
  return MODEL3D_ECOSYSTEMS.find((e) => e.id === id) ?? MODEL3D_ECOSYSTEMS[0];
}
