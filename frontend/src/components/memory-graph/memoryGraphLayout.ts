/**
 * Shared, render-agnostic layout + palette helpers for the memory graph.
 *
 * Adapted from OpenHuman (tinyhumansai/openhuman, GPLv3) — trimmed to the
 * SVG path: the WebGL/Pixi helpers (buildGraph, createSimulation, pickNode,
 * supportsWebGL, SimTuning) and the tree-level palette are omitted; node
 * kinds are kawai's `memory` / `entity` bipartite graph.
 *
 * Physics on the SVG path is the worker's d3-force simulation (Barnes–Hut);
 * this module owns the shared constants, colours, radii and glow rules so
 * the renderer and the worker stay consistent.
 */

/**
 * Layout is computed in this fixed coordinate space; the renderer pans/zooms
 * it.
 */
export const VIEWPORT_W = 1100;
export const VIEWPORT_H = 640;
/** Zoom floors shared by auto-fit framing and manual wheel zoom. */
export const ZOOM_MIN = 0.05;
export const ZOOM_MAX = 4;

export const MEMORY_COLOR = "#94A3B8"; // quiet slate for memory nodes
export const ENTITY_COLOR = "#A78BFA"; // violet for named entities

/** One node in the exported memory graph. */
export interface GraphNode {
  /** `mem-…` id for memories, `ent-…` for entities. */
  id: string;
  kind: "memory" | "entity";
  /** Display label — memory title or entity name. */
  label: string;
  /** Memory body (memory nodes only) — feeds the preview pane. */
  content?: string;
}

/** One entity→memory mention edge. */
export interface GraphEdge {
  from: string;
  to: string;
}

export function nodeColor(node: GraphNode): string {
  return node.kind === "entity" ? ENTITY_COLOR : MEMORY_COLOR;
}

export function nodeRadius(node: GraphNode): number {
  return node.kind === "entity" ? 9 : 4;
}

/** Entities glow; memories stay flat so the structure pops. */
export function nodeGlows(node: GraphNode): boolean {
  return node.kind === "entity";
}
