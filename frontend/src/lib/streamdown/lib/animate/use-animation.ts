import { useEffect, useRef, useState } from "react";
import type { Options } from "../markdown";
import { AnimationController } from "./controller";
import {
  type BlockSegmentCounter,
  createBlockSegmentCounter,
} from "./segment-counter";
import type { AnimateConfig, AnimationPlan } from "./transform";

/** Max segments animated in one chunk; older backlog snaps to settled. */
const COALESCE_CAP = 24;

const monotonicNow = (): number =>
  typeof performance === "undefined" ? Date.now() : performance.now();

export interface BlockAnimation {
  baseOrdinal: number;
  /** Effective plan in GLOBAL ordinals — clamped/frozen for settled blocks. */
  plan: AnimationPlan;
}

const IDLE: BlockAnimation = {
  baseOrdinal: 0,
  plan: { settledEnd: 0, activeEnd: 0 },
};

/** Render-tick latch: the wall-clock time the controller was last stepped with,
 *  keyed by the inputs that define a tick. */
interface Tick {
  gate: number;
  now: number;
  total: number;
  wake: number;
}
const newTick = (): Tick => ({ total: -1, gate: -1, wake: -1, now: 0 });

// Global ordinal offset of each block plus the total segment count.
const computeBaseOrdinals = (
  counts: number[]
): { baseOrdinals: number[]; total: number } => {
  const baseOrdinals: number[] = [];
  let acc = 0;
  for (const count of counts) {
    baseOrdinals.push(acc);
    acc += count;
  }
  return { baseOrdinals, total: acc };
};

// Map the global plan onto each block. Blocks the frontier has fully passed get
// a frozen plan (equal numbers) so React's block memo skips them; the rest share
// the live plan and re-render as it advances.
const toPerBlock = (
  baseOrdinals: number[],
  counts: number[],
  plan: AnimationPlan
): BlockAnimation[] =>
  baseOrdinals.map((base, i) => {
    const end = base + counts[i];
    return plan.settledEnd >= end
      ? { baseOrdinal: base, plan: { settledEnd: end, activeEnd: end } }
      : { baseOrdinal: base, plan };
  });

// Reuse the latched `now` while the tick inputs are unchanged so re-renders are
// idempotent; take a fresh reading (and re-latch) only on a genuinely new tick.
const latchNow = (
  ref: { current: Tick },
  total: number,
  gate: number,
  wake: number
): number => {
  const t = ref.current;
  if (t.total === total && t.gate === gate && t.wake === wake) {
    return t.now;
  }
  const now = monotonicNow();
  ref.current = { total, gate, wake, now };
  return now;
};

/**
 * Owns the animation scheduler for a Streamdown instance. Counts each block's
 * segments (cached per block string), drives the {@link AnimationController},
 * and returns the per-block effective plan. Settled blocks get a frozen plan so
 * React's memo skips them — only the animating tail re-renders each tick.
 */
export function useAnimation(params: {
  blocks: string[];
  config: AnimateConfig | null;
  /** While true the controller drives a streaming animation; when false the
   *  content is finalized (everything settled/visible) without tearing the
   *  plugin out of the pipeline. */
  isAnimating: boolean;
  countingOptions: Readonly<Omit<Options, "children">>;
  /** Highest global ordinal eligible to animate (atomic completeness gate). */
  gateAt?: number;
}): BlockAnimation[] {
  const { blocks, config, isAnimating, countingOptions, gateAt } = params;

  const controllerRef = useRef<AnimationController | null>(null);
  const counterRef = useRef<BlockSegmentCounter | null>(null);
  const configRef = useRef<AnimateConfig | null | undefined>(undefined);
  const countingOptionsRef = useRef<
    Readonly<Omit<Options, "children">> | undefined
  >(undefined);
  const hasAnimatedRef = useRef(false);
  // Latches the time the controller was stepped with so re-renders that don't
  // represent a new tick reuse it, keeping `controller.update` idempotent under
  // StrictMode double-invokes and discarded/restarted concurrent renders
  // (Streamdown drives block updates through startTransition). Reading a fresh
  // performance.now() every render would advance the controller with diverging
  // times and snap the cascade instead of fading it in.
  const tickRef = useRef<Tick>(newTick());
  const [wake, forceWake] = useState(0);

  if (isAnimating) {
    hasAnimatedRef.current = true;
  }

  // `config` and `countingOptions` are memoized by the caller, so reference
  // comparison is enough to detect a real change.
  const configChanged = configRef.current !== config;
  // The counter parses blocks with `countingOptions` and caches counts by them,
  // so it must be rebuilt when EITHER the config or the component/plugin set
  // changes — otherwise it counts a stale tree and misaligns segment ordinals.
  const counterStale =
    configChanged || countingOptionsRef.current !== countingOptions;

  if (configChanged) {
    configRef.current = config;
    controllerRef.current = config
      ? new AnimationController({
          duration: config.duration,
          stagger: config.stagger,
          coalesceCap: COALESCE_CAP,
        })
      : null;
    // Force a fresh `now` on the next step so a newly-built controller starts
    // its first chunk from the current time, not a stale latched value.
    tickRef.current = newTick();
  }

  if (counterStale) {
    countingOptionsRef.current = countingOptions;
    counterRef.current = config
      ? createBlockSegmentCounter(countingOptions, config)
      : null;
  }

  const controller = controllerRef.current;
  const counter = counterRef.current;

  let perBlock: BlockAnimation[];
  let wakeup: number | null = null;

  if (config && controller && counter) {
    const counts = blocks.map((block) => counter.count(block));
    const { baseOrdinals, total } = computeBaseOrdinals(counts);

    if (isAnimating || hasAnimatedRef.current) {
      // Streaming, or draining the backlog after the stream ended. The timer
      // below keeps driving the controller until everything is settled; stable
      // keys let this drain reconcile in place so the tail animates to
      // completion instead of snapping.
      const gate = gateAt ?? total;
      controller.update(total, gate, latchNow(tickRef, total, gate, wake));
      wakeup = controller.nextWakeup;
      perBlock = toPerBlock(baseOrdinals, counts, controller.plan);
    } else {
      // Never streamed (historical / static render): everything settled at once.
      perBlock = toPerBlock(baseOrdinals, counts, {
        settledEnd: total,
        activeEnd: total,
      });
    }
  } else {
    perBlock = blocks.map(() => IDLE);
  }

  // Only (re)schedule when the next completion time actually changes, so the
  // timer isn't cleared-and-reset on every streaming render (which would stop
  // it from ever firing and leave the final chunk un-animated).
  useEffect(() => {
    if (wakeup === null) {
      return;
    }
    const delay = Math.max(0, wakeup - monotonicNow()) + 1;
    const timer = setTimeout(() => forceWake((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [wakeup]);

  return perBlock;
}
