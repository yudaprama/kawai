/**
 * Obsidian-style force-directed memory graph — SVG renderer.
 *
 * Adapted from OpenHuman (tinyhumansai/openhuman, GPLv3): the dual
 * WebGL(Pixi)/SVG renderer is trimmed to the SVG path (kawai's memory stores
 * are person-scale, far below the 1000-node cap where WebGL pays off), the
 * tree mode is dropped in favour of the single memory↔entity bipartite graph,
 * and workspace-path actions become an in-panel content preview.
 *
 * Layout: d3-force in a worker (useSvgForceLayout) streaming positions into
 * imperative DOM writes; a synchronous O(n²) relax covers worker-less hosts
 * (tests). Interaction: drag a node to reposition it, drag the background to
 * pan, scroll to zoom, "Reset view" reframes. Click a memory node → its
 * content renders in the preview pane below.
 */
import {
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import { useTheme } from "@/hooks/use-theme";
import { Button } from "@/components/ui/button";

import { type GraphEdge, type GraphNode, nodeColor, nodeGlows, nodeRadius, VIEWPORT_H, VIEWPORT_W, ZOOM_MAX, ZOOM_MIN } from "./memoryGraphLayout";
import { seedSvgLayout } from "./seedSvgLayout";
import { useSvgForceLayout, WORKER_SUPPORTED } from "./useSvgForceLayout";

interface SimNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface SimState {
  sim: SimNode[];
  edges: Array<[number, number]>;
  radii: number[];
  alpha: number;
}

// Stable empties so the worker-layout effect's deps don't change every render
// when there's no graph yet.
const NO_NODES: SimNode[] = [];
const NO_RADII: number[] = [];
const NO_EDGES: Array<[number, number]> = [];
// Stable centre the SVG worker layout settles around (matches the viewBox).
const SVG_CENTER: readonly [number, number] = [VIEWPORT_W / 2, VIEWPORT_H / 2];

export interface MemoryGraphProps {
  /** Memory + entity nodes. */
  nodes: GraphNode[];
  /** Entity→memory mention edges. */
  edges: GraphEdge[];
  /** Optional override for the empty-state message. */
  emptyHint?: string;
  /** Fill the parent's height instead of the fixed 640px card. */
  fill?: boolean;
  /** Draw an always-on text label under each node. */
  showLabels?: boolean;
  /**
   * Fired exactly once when the graph's force layout first settles (worker
   * `end` or the synchronous relax fallback).
   */
  onReady?: () => void;
}

interface MemoryPreviewState {
  title: string;
  content: string;
}

/**
 * Map a pointer's client coords into the SVG's viewBox coordinate space.
 * Returns null without a live CTM (e.g. jsdom) so the pan/zoom handlers
 * degrade to no-ops under test.
 */
function clientToViewBox(
  svg: SVGSVGElement | null,
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  if (!svg || typeof svg.getScreenCTM !== "function") return null;
  const ctm = svg.getScreenCTM();
  if (!ctm) return null;
  const inv = ctm.inverse();
  return {
    x: inv.a * clientX + inv.c * clientY + inv.e,
    y: inv.b * clientX + inv.d * clientY + inv.f,
  };
}

/**
 * Run the force simulation for `iterations` ticks. Mutates positions in
 * place so we can re-use the same buffer across renders. Worker-less
 * fallback only (tests) — the worker path never runs this.
 */
function relaxLayout(nodes: SimNode[], edges: Array<[number, number]>, iterations = 220): void {
  const REPULSION = 1800;
  const SPRING_K = 0.04;
  const SPRING_LEN = 60;
  const CENTER_K = 0.0025;
  const FRICTION = 0.85;
  const cx = VIEWPORT_W / 2;
  const cy = VIEWPORT_H / 2;

  for (let iter = 0; iter < iterations; iter++) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i];
        const b = nodes[j];
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const dist2 = dx * dx + dy * dy + 0.01;
        const force = REPULSION / dist2;
        const dist = Math.sqrt(dist2);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx += fx;
        a.vy += fy;
        b.vx -= fx;
        b.vy -= fy;
      }
    }
    for (const [ai, bi] of edges) {
      const a = nodes[ai];
      const b = nodes[bi];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) + 0.01;
      const delta = dist - SPRING_LEN;
      const fx = (dx / dist) * delta * SPRING_K;
      const fy = (dy / dist) * delta * SPRING_K;
      a.vx += fx;
      a.vy += fy;
      b.vx -= fx;
      b.vy -= fy;
    }
    for (const n of nodes) {
      n.vx += (cx - n.x) * CENTER_K;
      n.vy += (cy - n.y) * CENTER_K;
      n.vx *= FRICTION;
      n.vy *= FRICTION;
      n.x += n.vx;
      n.y += n.vy;
    }
  }
}

export function MemoryGraph({ nodes, edges, emptyHint, fill, showLabels, onReady }: MemoryGraphProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [hovered, setHovered] = useState<GraphNode | null>(null);

  // Fire `onReady` at most once across this component's lifetime. The latest
  // callback is held in a ref so `fireReady` stays stable (the SVG layout hook
  // depends on a stable `onSettled`, and the guard prevents refires on reheat).
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  const readyFiredRef = useRef(false);
  const fireReady = useCallback(() => {
    if (readyFiredRef.current) return;
    readyFiredRef.current = true;
    onReadyRef.current?.();
  }, []);
  const [preview, setPreview] = useState<MemoryPreviewState | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Pan / zoom transform applied to the graph group, plus the live drag
  // state. Node positions live in the memoised `sim` buffer and are
  // mutated in place during a node drag; `bumpTick` forces a re-render so
  // the moved node repaints without re-running the physics.
  const [view, setView] = useState({ tx: 0, ty: 0, scale: 1 });
  const [, bumpTick] = useReducer((c: number) => c + 1, 0);
  const [grabbing, setGrabbing] = useState(false);
  const dragRef = useRef<
    | { kind: "node"; node: SimNode; dx: number; dy: number }
    | { kind: "pan"; vbStartX: number; vbStartY: number; tx0: number; ty0: number }
    | null
  >(null);
  // True once the pointer moved during the current gesture — guards the
  // node click so a drag doesn't also open the preview.
  const movedRef = useRef(false);
  // Halts the SVG layout worker once the user grabs a node/background, so its
  // streamed positions stop fighting the manual drag.
  const stopLayoutRef = useRef<() => void>(() => {});
  // Set once the user grabs the camera, so the settle-time auto-fit doesn't
  // yank the view out from under them.
  const userInteractedRef = useRef(false);
  // Re-frame the SVG graph from "Reset view" (set after fitToView below).
  const fitRef = useRef<() => void>(() => {});
  // Holds the current sim across renders; during the next build it still points
  // at the OUTGOING sim, whose nodes carry the latest live coordinates (the
  // worker / a drag mutate them in place) — read for position carry-over.
  const liveSimRef = useRef<SimState | null>(null);

  const clientToGraph = useCallback(
    (clientX: number, clientY: number) => {
      const vb = clientToViewBox(svgRef.current, clientX, clientY);
      if (!vb) return null;
      return { x: (vb.x - view.tx) / view.scale, y: (vb.y - view.ty) / view.scale };
    },
    [view],
  );

  const onNodePointerDown = useCallback(
    (e: ReactPointerEvent, n: SimNode) => {
      // Stop the background pan from also starting on this pointer down.
      e.stopPropagation();
      movedRef.current = false;
      const g = clientToGraph(e.clientX, e.clientY);
      if (!g) return;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      dragRef.current = { kind: "node", node: n, dx: g.x - n.x, dy: g.y - n.y };
      setGrabbing(true);
    },
    [clientToGraph],
  );

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      movedRef.current = false;
      const vb = clientToViewBox(svgRef.current, e.clientX, e.clientY);
      if (!vb) return;
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      dragRef.current = { kind: "pan", vbStartX: vb.x, vbStartY: vb.y, tx0: view.tx, ty0: view.ty };
      setGrabbing(true);
    },
    [view],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      // On the first real movement (not a plain click), hand the camera to the
      // user: freeze the worker layout and suppress the settle-time auto-fit.
      if (!movedRef.current) {
        stopLayoutRef.current();
        userInteractedRef.current = true;
      }
      if (d.kind === "node") {
        const g = clientToGraph(e.clientX, e.clientY);
        if (!g) return;
        d.node.x = g.x - d.dx;
        d.node.y = g.y - d.dy;
        movedRef.current = true;
        bumpTick();
      } else {
        const vb = clientToViewBox(svgRef.current, e.clientX, e.clientY);
        if (!vb) return;
        movedRef.current = true;
        setView((v) => ({ ...v, tx: d.tx0 + (vb.x - d.vbStartX), ty: d.ty0 + (vb.y - d.vbStartY) }));
      }
    },
    [clientToGraph],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    setGrabbing(false);
  }, []);

  const onWheelZoom = useCallback((e: ReactWheelEvent) => {
    const vb = clientToViewBox(svgRef.current, e.clientX, e.clientY);
    if (!vb) return;
    userInteractedRef.current = true;
    setView((v) => {
      const factor = Math.exp(-e.deltaY * 0.0015);
      const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v.scale * factor));
      // Keep the graph point under the cursor fixed while zooming.
      const gx = (vb.x - v.tx) / v.scale;
      const gy = (vb.y - v.ty) / v.scale;
      return { scale, tx: vb.x - gx * scale, ty: vb.y - gy * scale };
    });
  }, []);

  const resetView = useCallback(() => {
    userInteractedRef.current = false;
    fitRef.current();
  }, []);

  // Build edges + seed positions, carrying over the last positions of any
  // surviving node so a live data update doesn't reshuffle the whole graph
  // (seedSvgLayout). The O(n²) relax only runs as the no-worker fallback (test
  // env); the worker settles otherwise.
  const sim = useMemo<SimState | null>(() => {
    if (!nodes || nodes.length === 0) return null;
    // Snapshot the OUTGOING graph's live coordinates so survivors carry over
    // from where they actually are now — not a stale init/settle snapshot —
    // even mid-settle or after a drag.
    const prev = liveSimRef.current;
    const prevPos = new Map<string, { x: number; y: number }>();
    if (prev) for (const n of prev.sim) prevPos.set(n.id, { x: n.x, y: n.y });
    const seed = seedSvgLayout(nodes, edges, prevPos);
    const simNodes: SimNode[] = nodes.map((n, i) => ({
      ...n,
      x: seed.positions[i].x,
      y: seed.positions[i].y,
      vx: 0,
      vy: 0,
    }));
    const radii = simNodes.map((n) => nodeRadius(n));
    if (!WORKER_SUPPORTED) relaxLayout(simNodes, seed.edges);
    return { sim: simNodes, edges: seed.edges, radii, alpha: seed.reheatAlpha };
  }, [nodes, edges]);
  // Becomes the "previous" sim on the next build (above).
  liveSimRef.current = sim;

  // Element refs for imperative position updates: while the worker streams
  // positions we write cx/cy (and line endpoints) straight to the DOM instead
  // of re-rendering up to 10k elements through React every frame.
  const circleEls = useRef<(SVGCircleElement | null)[]>([]);
  const lineEls = useRef<(SVGLineElement | null)[]>([]);
  const textEls = useRef<(SVGTextElement | null)[]>([]);

  // Progressive DOM mount: reveal nodes in per-frame batches so a large graph
  // never blocks building thousands of elements in one commit.
  const FIRST_BATCH = 800;
  const [svgVisible, setSvgVisible] = useState(() => (sim ? Math.min(sim.sim.length, FIRST_BATCH) : 0));
  // Reset the reveal window + element refs during render when the graph data
  // changes (the recommended alternative to setState-in-effect).
  const simIdRef = useRef(sim);
  if (simIdRef.current !== sim) {
    simIdRef.current = sim;
    circleEls.current = [];
    lineEls.current = [];
    textEls.current = [];
    setSvgVisible(sim ? Math.min(sim.sim.length, FIRST_BATCH) : 0);
  }

  // Latest visible count read by the stable imperative applier without
  // re-subscribing the worker every render.
  const latestVisibleRef = useRef(svgVisible);
  latestVisibleRef.current = svgVisible;

  // Write current positions straight to the mounted SVG elements.
  const applyPositions = useCallback(() => {
    const s = liveSimRef.current;
    if (!s) return;
    const vis = latestVisibleRef.current;
    const ns = s.sim;
    for (let i = 0; i < vis && i < ns.length; i++) {
      const el = circleEls.current[i];
      if (el) {
        el.setAttribute("cx", String(ns[i].x));
        el.setAttribute("cy", String(ns[i].y));
      }
      const tel = textEls.current[i];
      if (tel) {
        tel.setAttribute("x", String(ns[i].x));
        tel.setAttribute("y", String(ns[i].y + nodeRadius(ns[i]) + 12));
      }
    }
    for (let e = 0; e < s.edges.length; e++) {
      const [ai, bi] = s.edges[e];
      if (ai >= vis || bi >= vis) continue;
      const el = lineEls.current[e];
      if (el) {
        el.setAttribute("x1", String(ns[ai].x));
        el.setAttribute("y1", String(ns[ai].y));
        el.setAttribute("x2", String(ns[bi].x));
        el.setAttribute("y2", String(ns[bi].y));
      }
    }
  }, []);

  // Frame the whole cloud in the viewport. d3-force spreads a large graph far
  // past the viewBox, so without this most nodes sit off-screen. Committed to
  // `view` state (single source) so pan/zoom keep working; called once the
  // worker settles, unless the user already grabbed the camera.
  const fitToView = useCallback(() => {
    const s = liveSimRef.current;
    if (!s || userInteractedRef.current) return;
    const ns = s.sim;
    if (ns.length === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of ns) {
      const r = nodeRadius(n) + 8;
      minX = Math.min(minX, n.x - r);
      minY = Math.min(minY, n.y - r);
      maxX = Math.max(maxX, n.x + r);
      maxY = Math.max(maxY, n.y + r);
    }
    const w = Math.max(1, maxX - minX);
    const h = Math.max(1, maxY - minY);
    const scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.min(VIEWPORT_W / w, VIEWPORT_H / h) * 0.92));
    const bx = (minX + maxX) / 2;
    const by = (minY + maxY) / 2;
    setView({ scale, tx: VIEWPORT_W / 2 - bx * scale, ty: VIEWPORT_H / 2 - by * scale });
  }, []);
  fitRef.current = fitToView;

  // Coalesce worker ticks to one DOM write per frame.
  const applyPendingRef = useRef(false);
  const scheduleApply = useCallback(() => {
    if (applyPendingRef.current) return;
    applyPendingRef.current = true;
    const run = () => {
      applyPendingRef.current = false;
      applyPositions();
    };
    if (typeof window.requestAnimationFrame === "function") window.requestAnimationFrame(run);
    else run();
  }, [applyPositions]);

  // Frame the graph then signal readiness once the worker layout cools.
  const onSvgSettled = useCallback(() => {
    fitToView();
    fireReady();
  }, [fitToView, fireReady]);

  // SVG layout runs in a worker (off the main thread); positions stream back
  // and are applied imperatively. No-op where workers are unavailable (the
  // synchronous relaxLayout above covers that case).
  const svgLayout = useSvgForceLayout(
    !!sim,
    sim?.sim ?? NO_NODES,
    sim?.radii ?? NO_RADII,
    sim?.edges ?? NO_EDGES,
    SVG_CENTER,
    sim?.alpha ?? 1,
    scheduleApply,
    onSvgSettled,
  );
  stopLayoutRef.current = svgLayout.stop;

  // Synchronous-layout path (no Worker — e.g. jsdom under test):
  // `relaxLayout` already ran inside the `sim` memo, so the graph is laid out
  // as soon as `sim` exists. Signal readiness on the next tick.
  useEffect(() => {
    if (WORKER_SUPPORTED || !sim) return;
    fireReady();
  }, [sim, fireReady]);

  // Ramp the rest in per-frame batches (setState only inside the rAF callback).
  useEffect(() => {
    if (!sim) return;
    const total = sim.sim.length;
    if (total <= FIRST_BATCH || typeof window.requestAnimationFrame !== "function") return;
    let raf = 0;
    const step = () => {
      setSvgVisible((c) => {
        const next = Math.min(total, c + 1200);
        if (next < total) raf = window.requestAnimationFrame(step);
        return next;
      });
    };
    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [sim]);

  if (nodes.length === 0) {
    return (
      <div
        className="text-muted-foreground flex h-[640px] items-center justify-center rounded-lg border text-sm"
        data-testid="memory-graph-empty">
        {emptyHint ?? "No memories to graph yet."}
      </div>
    );
  }

  if (!sim) return null;

  return (
    <div className="memory-graph rounded-lg border" onMouseLeave={() => setHovered(null)}>
      <div className="flex flex-none items-center justify-between gap-4 border-b px-4 py-2">
        <div className="text-muted-foreground flex items-center gap-3 text-xs">
          <span>{nodes.length} nodes</span>
          <span className="opacity-50">·</span>
          <span>
            {sim.edges.length} {sim.edges.length === 1 ? "link" : "links"}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#94A3B8" }} />
            Memory
          </span>
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: "#A78BFA" }} />
            Entity
          </span>
          <Button
            onClick={resetView}
            data-testid="memory-graph-reset-view"
            size="xs"
            variant="outline"
            className="text-[11px]">
            Reset view
          </Button>
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${VIEWPORT_W} ${VIEWPORT_H}`}
        className={`block w-full touch-none select-none ${fill ? "min-h-0 flex-1" : ""}`}
        style={{
          height: fill ? "100%" : "min(640px, calc(100vh - 22rem))",
          cursor: grabbing ? "grabbing" : "grab",
        }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerLeave={endDrag}
        onWheel={onWheelZoom}
        data-testid="memory-graph-svg">
        {/* Pan / zoom group — drag the background to pan, scroll to zoom. */}
        <g transform={`translate(${view.tx} ${view.ty}) scale(${view.scale})`}>
          <g stroke={isDark ? "#cbd5e1" : "#475569"} strokeWidth={isDark ? 0.6 : 1.2} opacity={0.7}>
            {sim.edges.map(([ai, bi], idx) => {
              // Only draw edges whose endpoints are both mounted yet.
              if (ai >= svgVisible || bi >= svgVisible) return null;
              const a = sim.sim[ai];
              const b = sim.sim[bi];
              return (
                <line
                  key={idx}
                  ref={(el) => {
                    lineEls.current[idx] = el;
                  }}
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                />
              );
            })}
          </g>
          <g>
            {sim.sim.slice(0, svgVisible).map((n, i) => {
              const r = nodeRadius(n);
              const fill = nodeColor(n);
              const isHover = hovered?.id === n.id;
              // Entities glow; memories stay flat so the structure pops.
              const glow = nodeGlows(n) ? `drop-shadow(0 0 ${isHover ? 7 : 4}px ${fill})` : undefined;
              return (
                <circle
                  key={n.id}
                  ref={(el) => {
                    circleEls.current[i] = el;
                  }}
                  cx={n.x}
                  cy={n.y}
                  r={isHover ? r + 2 : r}
                  fill={fill}
                  stroke={isHover ? (isDark ? "#0f172a" : "#1e293b") : isDark ? "#ffffff" : "#e2e8f0"}
                  strokeWidth={isHover ? 1.4 : 0.8}
                  style={{ cursor: grabbing ? "grabbing" : "pointer", filter: glow }}
                  onPointerDown={(e) => onNodePointerDown(e, n)}
                  onMouseEnter={() => setHovered(n)}
                  onClick={() => {
                    // A drag ends with a click event too — skip the open
                    // when the pointer actually moved.
                    if (movedRef.current) return;
                    if (n.kind === "memory") {
                      setPreview({ title: n.label, content: n.content ?? "" });
                    }
                  }}
                  data-testid={`memory-graph-node-${n.id}`}>
                  <title>{n.label}</title>
                </circle>
              );
            })}
          </g>
          {showLabels && (
            <g>
              {sim.sim.slice(0, svgVisible).map((n, i) => {
                const label = (n.label ?? "").trim();
                const text = label.length > 22 ? `${label.slice(0, 21)}…` : label;
                return (
                  <text
                    key={n.id}
                    ref={(el) => {
                      textEls.current[i] = el;
                    }}
                    x={n.x}
                    y={n.y + nodeRadius(n) + 12}
                    textAnchor="middle"
                    fontSize={13}
                    fill={isDark ? "#e2e8f0" : "#334155"}
                    style={{ pointerEvents: "none", userSelect: "none" }}>
                    {text}
                  </text>
                );
              })}
            </g>
          )}
        </g>
      </svg>
      {hovered && (
        <div className="text-muted-foreground border-t px-4 py-2 text-xs" data-testid="memory-graph-tooltip">
          {hovered.kind === "entity" ? (
            <>
              <span className="font-medium text-violet-600 dark:text-violet-300">{hovered.label}</span>
              <span className="ml-3 opacity-70">entity · {hovered.id.slice(0, 12)}…</span>
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">{hovered.label || "memory"}</span>
              <span className="ml-3 opacity-70">memory</span>
            </>
          )}
        </div>
      )}
      {preview && (
        <div className="border-t px-4 py-3" data-testid="memory-graph-preview">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-foreground text-sm font-medium">{preview.title}</span>
            <Button onClick={() => setPreview(null)} size="xs" variant="ghost" className="text-[11px]">
              Close
            </Button>
          </div>
          <pre className="text-muted-foreground max-h-40 overflow-auto rounded-md bg-[var(--tea-color-bg-secondary-default)] p-3 text-xs whitespace-pre-wrap">
            {preview.content || "(empty)"}
          </pre>
        </div>
      )}
    </div>
  );
}
