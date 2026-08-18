import type { Options } from "../markdown";
import { buildHast } from "../markdown";
import { type AnimateConfig, enumerateSegments } from "./transform";

/**
 * Segment count for a single block, computed from a tree identical to the one
 * rendered (minus the animation wrapping, which never changes the count).
 * Cached per block string + counting-options identity, so settled blocks aren't
 * re-parsed every streaming tick.
 */
export interface BlockSegmentCounter {
  count: (block: string) => number;
}

// Bounded so a long stream — which queries a new prefix of the growing block
// every tick — can't accumulate dead entries without limit. Hot blocks (the
// settled ones, re-queried each tick) are kept by moving them to the most-
// recent end on hit, so only stale prefixes fall out the LRU front.
const SEGMENT_COUNT_CACHE_MAX = 256;

export const createBlockSegmentCounter = (
  options: Readonly<Omit<Options, "children">>,
  config: AnimateConfig
): BlockSegmentCounter => {
  const cache = new Map<string, number>();
  return {
    count(block) {
      const cached = cache.get(block);
      if (cached !== undefined) {
        cache.delete(block);
        cache.set(block, cached);
        return cached;
      }
      const tree = buildHast({ ...options, children: block });
      const n = enumerateSegments(tree, config).length;
      cache.set(block, n);
      if (cache.size > SEGMENT_COUNT_CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) {
          cache.delete(oldest);
        }
      }
      return n;
    },
  };
};
