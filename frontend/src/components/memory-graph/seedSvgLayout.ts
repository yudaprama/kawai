/**
 * Position seeding for the SVG force layout, with incremental carry-over.
 *
 * Adapted from OpenHuman (tinyhumansai/openhuman, GPLv3) — contacts mode
 * only: kawai's graph is a fixed memory↔entity bipartite graph, so the
 * tree/parent_id branches are removed.
 *
 * When the graph data changes (a new memory is extracted, a consolidation
 * runs) the component re-derives its node array. Re-seeding every node from
 * scratch makes the whole graph reshuffle and re-settle — jarring on a live
 * update. Instead this keeps each surviving node (same `id`) at its previous
 * position, seeds genuinely-new nodes on a deterministic ring, and reports a
 * `reheatAlpha`: a gentle 0.3 when anything carried over, or a full 1 for a
 * first / fully-new graph. Pure and deterministic (no RNG / clock).
 */
import { type GraphEdge, type GraphNode, VIEWPORT_H, VIEWPORT_W } from "./memoryGraphLayout";

interface SeededPosition {
  x: number;
  y: number;
  /** True when the node had no carried-over position (newly arrived). */
  isNew: boolean;
}

interface SeedResult {
  /** Index-aligned with the input `nodes`. */
  positions: SeededPosition[];
  /** Edge index pairs [fromIdx, toIdx]. */
  edges: Array<[number, number]>;
  /** How many nodes had no previous position. */
  newCount: number;
  /** Initial simulation alpha: gentle (0.3) on an incremental update, full (1) otherwise. */
  reheatAlpha: number;
}

const CX = VIEWPORT_W / 2;
const CY = VIEWPORT_H / 2;

/** Deterministic ring position around the viewport centre for index `i`. */
function ringPosition(i: number, total: number): { x: number; y: number } {
  const angle = (i / Math.max(1, total)) * Math.PI * 2;
  const r = 200 + (i % 7) * 12;
  return { x: CX + Math.cos(angle) * r, y: CY + Math.sin(angle) * r };
}

export function seedSvgLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  prev: ReadonlyMap<string, { x: number; y: number }>,
): SeedResult {
  const idIndex = new Map<string, number>();
  nodes.forEach((n, i) => idIndex.set(n.id, i));

  const positions: SeededPosition[] = nodes.map((n, i) => {
    const carried = prev.get(n.id);
    if (carried) return { x: carried.x, y: carried.y, isNew: false };
    const ring = ringPosition(i, nodes.length);
    return { x: ring.x, y: ring.y, isNew: true };
  });

  const edgeIndices: Array<[number, number]> = [];
  for (const e of edges) {
    const a = idIndex.get(e.from);
    const b = idIndex.get(e.to);
    if (a == null || b == null) continue;
    edgeIndices.push([a, b]);
  }

  const newCount = positions.reduce((acc, p) => acc + (p.isNew ? 1 : 0), 0);
  // Gentle reheat only when at least one node survived (an incremental update);
  // a first load or a fully-replaced graph gets a full settle.
  const reheatAlpha = nodes.length > 0 && newCount < nodes.length ? 0.3 : 1;

  return { positions, edges: edgeIndices, newCount, reheatAlpha };
}
