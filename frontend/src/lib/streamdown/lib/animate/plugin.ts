import type { Root } from "hast";
import {
  type AnimateConfig,
  type AnimationPlan,
  applyAnimation,
  DEFAULT_ANIMATE_CONFIG,
} from "./transform";

export interface AnimateOptions {
  animation?: AnimateConfig["animation"];
  duration?: number;
  easing?: string;
  /**
   * Reserve layout space for not-yet-revealed content (fade opacity only)
   * instead of collapsing it with `display: none`. Defaults to `false`, which
   * grows content in as it reveals; set `true` for a stable, shift-free layout.
   */
  reserveSpace?: boolean;
  sep?: "word" | "char";
  stagger?: number;
}

export const resolveAnimateConfig = (
  options?: AnimateOptions | boolean
): AnimateConfig => {
  if (!options || options === true) {
    return DEFAULT_ANIMATE_CONFIG;
  }
  return {
    animation: options.animation ?? DEFAULT_ANIMATE_CONFIG.animation,
    duration: options.duration ?? DEFAULT_ANIMATE_CONFIG.duration,
    easing: options.easing ?? DEFAULT_ANIMATE_CONFIG.easing,
    reserveSpace: options.reserveSpace ?? DEFAULT_ANIMATE_CONFIG.reserveSpace,
    sep: options.sep ?? DEFAULT_ANIMATE_CONFIG.sep,
    stagger: options.stagger ?? DEFAULT_ANIMATE_CONFIG.stagger,
  };
};

/**
 * Per-Streamdown animate plugin. A SINGLE instance is shared across every block
 * of one Streamdown (so all blocks reuse one cached unified processor — the
 * processor cache in markdown.ts keys by the rehype plugin's function name).
 *
 * Because the instance is shared, each `Block` writes ITS `(baseOrdinal, plan)`
 * via `setBlockState` at the top of its render body, immediately before the
 * child `Markdown` runs `processor.runSync`. `runSync` is fully synchronous and
 * the write + read live in one synchronous `Block` body, so nothing can
 * interleave between them — the plugin reads exactly the state for the block
 * currently rendering. See the matching note in `Block` (index.tsx).
 */
export interface AnimatePlugin {
  name: "animate";
  // biome-ignore lint/suspicious/noExplicitAny: unified Pluggable typing varies by processor
  rehypePlugin: any;
  setBlockState: (baseOrdinal: number, plan: AnimationPlan) => void;
  type: "animate";
}

let instanceId = 0;

/** Build a plugin from a fully-resolved config (used internally by Streamdown,
 *  which already resolves the config to drive the segment counter). */
export function createAnimatePluginFromConfig(
  config: AnimateConfig
): AnimatePlugin {
  const state = {
    baseOrdinal: 0,
    plan: { settledEnd: 0, activeEnd: 0 } as AnimationPlan,
  };
  const id = instanceId++;

  const rehypeAnimate = () => (tree: Root) => {
    applyAnimation(tree, state.plan, config, state.baseOrdinal);
  };
  // Unique name so the markdown processor cache (keyed by plugin name) gives
  // each Streamdown instance its own processor reading its own state.
  Object.defineProperty(rehypeAnimate, "name", {
    value: `rehypeAnimate$${id}`,
  });

  return {
    name: "animate",
    type: "animate",
    rehypePlugin: rehypeAnimate,
    setBlockState(baseOrdinal, plan) {
      state.baseOrdinal = baseOrdinal;
      state.plan = plan;
    },
  };
}

/**
 * Public entry point for the rehype animate plugin. Accepts the same loose
 * {@link AnimateOptions} as the `animated` prop and resolves defaults before
 * building the plugin.
 */
export function createAnimatePlugin(options?: AnimateOptions): AnimatePlugin {
  return createAnimatePluginFromConfig(resolveAnimateConfig(options));
}
