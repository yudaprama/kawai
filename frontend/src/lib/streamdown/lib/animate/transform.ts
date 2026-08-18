import type { Element, ElementContent, Parent, Root, Text } from "hast";

export type AnimationName = "fadeIn" | "blurIn" | "slideUp" | (string & {});

export interface AnimateConfig {
  animation: AnimationName;
  duration: number;
  easing: string;
  /**
   * Reserve layout space for not-yet-revealed content (fade opacity only)
   * instead of collapsing it with `display: none`. Trades the progressive
   * "grow-in" reveal for a stable layout with no shift. Consumed only by the
   * root CSS variable, not the transform itself.
   */
  reserveSpace: boolean;
  sep: "word" | "char";
  stagger: number;
}

export const DEFAULT_ANIMATE_CONFIG: AnimateConfig = {
  animation: "fadeIn",
  duration: 150,
  easing: "ease",
  reserveSpace: false,
  sep: "word",
  stagger: 40,
};

/**
 * Frontier between the three animation zones, expressed in segment ordinals
 * (document order). Ordinals `[0, settledEnd)` are settled (plain, visible),
 * `[settledEnd, activeEnd)` are the animating chunk, and `>= activeEnd` are
 * pending (rendered but display:none).
 */
export interface AnimationPlan {
  activeEnd: number;
  settledEnd: number;
}

export interface SegmentInfo {
  /** Whole-element segments (code blocks, images, math, mermaid) vs text units. */
  atomic: boolean;
  ordinal: number;
}

const WHITESPACE_ONLY_RE = /^\s+$/;
const WHITESPACE_SPLIT_RE = /\s+/;
// Each unit is a whitespace run or a visible run (word mode) / single visible
// character (char mode). Whitespace runs are kept so they render between units.
const WORD_SPLIT_RE = /\s+|\S+/g;
const CHAR_SPLIT_RE = /\s+|\S/g;

const ATOMIC_TAGS = new Set(["pre", "img", "hr", "svg", "math", "video", "iframe"]);
const ATOMIC_CLASSES = new Set([
  "katex",
  "katex-display",
  "math",
  "math-display",
]);

const elementClasses = (el: Element): string[] => {
  const cls = el.properties?.className;
  if (Array.isArray(cls)) {
    return cls.map(String);
  }
  if (typeof cls === "string") {
    return cls.split(WHITESPACE_SPLIT_RE);
  }
  return [];
};

const isAtomic = (el: Element): boolean =>
  ATOMIC_TAGS.has(el.tagName) ||
  elementClasses(el).some((c) => ATOMIC_CLASSES.has(c));

const LIST_CONTAINER_TAGS = new Set(["ul", "ol", "li"]);

// Recurse into element children to find a checkbox (<input>), but never
// cross into a nested list (which would grab a sub-item's checkbox).
const findCheckbox = (element: Element): Element | undefined => {
  for (const child of element.children) {
    if (child.type === "element") {
      if (child.tagName === "input") {
        return child;
      }
      if (LIST_CONTAINER_TAGS.has(child.tagName)) {
        continue;
      }
      const nested = findCheckbox(child);
      if (nested) {
        return nested;
      }
    }
  }
  return undefined;
};

const splitText = (text: string, sep: "word" | "char"): string[] =>
  text.match(sep === "char" ? CHAR_SPLIT_RE : WORD_SPLIT_RE) ?? [];

interface Zone {
  /** Animation delay in ms, only set when kind === "active". */
  delay: number;
  kind: "settled" | "active" | "pending";
}

const classify = (
  ordinal: number,
  plan: AnimationPlan,
  stagger: number
): Zone => {
  if (ordinal < plan.settledEnd) {
    return { kind: "settled", delay: 0 };
  }
  if (ordinal < plan.activeEnd) {
    return { kind: "active", delay: (ordinal - plan.settledEnd) * stagger };
  }
  return { kind: "pending", delay: 0 };
};

interface Aggregate {
  hasActive: boolean;
  hasPending: boolean;
  hasSettled: boolean;
  minActiveDelay: number;
}

const emptyAggregate = (): Aggregate => ({
  hasSettled: false,
  hasActive: false,
  hasPending: false,
  minActiveDelay: Number.POSITIVE_INFINITY,
});

const fold = (into: Aggregate, from: Aggregate): void => {
  into.hasSettled ||= from.hasSettled;
  into.hasActive ||= from.hasActive;
  into.hasPending ||= from.hasPending;
  if (from.minActiveDelay < into.minActiveDelay) {
    into.minActiveDelay = from.minActiveDelay;
  }
};

interface Ctx {
  config: AnimateConfig;
  counter: { value: number };
  /** Monotonic source of keys for nodes lacking source positions. */
  fallbackKey: { value: number };
  /** Track nesting depth inside <a> elements for link whitespace merging. */
  linkDepth: number;
  /** null => collect mode (no mutation), otherwise wrap mode. */
  plan: AnimationPlan | null;
  segments: SegmentInfo[];
}

const appendStyle = (el: Element, css: string): void => {
  const props = el.properties ?? {};
  const prior = typeof props.style === "string" ? `${props.style};` : "";
  el.properties = { ...props, style: prior + css };
};

const animationStyle = (delay: number, config: AnimateConfig): string =>
  `--sd-animation:sd-${config.animation};--sd-duration:${config.duration}ms;--sd-easing:${config.easing};--sd-delay:${delay}ms`;

const segmentSpan = (
  value: string,
  key: string,
  props: Element["properties"]
): Element => ({
  type: "element",
  tagName: "span",
  properties: { ...props, "data-sd-key": key },
  children: [{ type: "text", value }],
});

const animatedSpan = (
  value: string,
  delay: number,
  config: AnimateConfig,
  key: string
): Element =>
  segmentSpan(value, key, {
    "data-sd-animate": true,
    style: animationStyle(delay, config),
  });

const hiddenSpan = (value: string, key: string): Element =>
  segmentSpan(value, key, { "data-sd-hidden": true });

// Settled units stay wrapped in a span (never a bare text node) so a unit only
// changes attributes — not node type — as it moves between zones; flipping
// text<->element across renders corrupts React's child reconciliation.
const shownSpan = (value: string, key: string): Element =>
  segmentSpan(value, key, { "data-sd-shown": true });

// Stable key prefix for one source node: the source character offset is unique
// tree-wide and append-stable (later text never shifts earlier offsets). Nodes
// without position data fall back to a traversal-ordered counter.
const keyPrefix = (
  node: { position?: { start?: { offset?: number } } },
  tag: string,
  ctx: Ctx
): string => {
  const offset = node.position?.start?.offset;
  return offset === undefined
    ? `${tag}f${ctx.fallbackKey.value++}`
    : `${tag}${offset}`;
};

const processText = (
  node: Text,
  parent: Parent,
  index: number,
  ctx: Ctx
): { agg: Aggregate; consumed: number } => {
  const agg = emptyAggregate();
  const units = splitText(node.value, ctx.config.sep);
  const replacement: ElementContent[] = [];
  const base = keyPrefix(node, "t", ctx);
  let consumedChars = 0;

  for (const unit of units) {
    const key = `${base}+${consumedChars}`;
    consumedChars += unit.length;
    if (WHITESPACE_ONLY_RE.test(unit)) {
      // Inside a link in word mode, merge whitespace into the preceding
      // word span so underlines render continuously instead of breaking.
      if (
        ctx.linkDepth > 0 &&
        ctx.config.sep === "word" &&
        replacement.length > 0
      ) {
        const last = replacement[replacement.length - 1];
        if (last.type === "element") {
          const textChild = last.children[0];
          if (textChild?.type === "text") {
            textChild.value += unit;
            continue;
          }
        }
      }
      // Wrap whitespace in a span too, so every child of the parent is a keyed
      // element. Mixing keyed spans with unkeyed text nodes makes React's
      // reconciliation drop/strand nodes as the split changes each render.
      replacement.push(shownSpan(unit, key));
      continue;
    }
    const ordinal = ctx.counter.value++;
    if (!ctx.plan) {
      ctx.segments.push({ ordinal, atomic: false });
      continue;
    }
    const zone = classify(ordinal, ctx.plan, ctx.config.stagger);
    if (zone.kind === "settled") {
      agg.hasSettled = true;
      replacement.push(shownSpan(unit, key));
    } else if (zone.kind === "active") {
      agg.hasActive = true;
      agg.minActiveDelay = Math.min(agg.minActiveDelay, zone.delay);
      replacement.push(animatedSpan(unit, zone.delay, ctx.config, key));
    } else {
      agg.hasPending = true;
      replacement.push(hiddenSpan(unit, key));
    }
  }

  if (!ctx.plan) {
    return { agg, consumed: 1 };
  }
  parent.children.splice(index, 1, ...replacement);
  return { agg, consumed: replacement.length };
};

const processAtomic = (el: Element, ctx: Ctx): Aggregate => {
  const agg = emptyAggregate();
  const ordinal = ctx.counter.value++;
  if (!ctx.plan) {
    ctx.segments.push({ ordinal, atomic: true });
    return agg;
  }
  const key = keyPrefix(el, "a", ctx);
  el.properties = { ...el.properties, "data-sd-key": key };
  const zone = classify(ordinal, ctx.plan, ctx.config.stagger);
  if (zone.kind === "settled") {
    agg.hasSettled = true;
  } else if (zone.kind === "active") {
    agg.hasActive = true;
    agg.minActiveDelay = zone.delay;
    el.properties = {
      ...el.properties,
      "data-sd-animate": true,
      "data-sd-animating": true,
    };
    appendStyle(el, animationStyle(zone.delay, ctx.config));
  } else {
    agg.hasPending = true;
    el.properties = {
      ...el.properties,
      "data-sd-hidden": true,
      "data-sd-animating": true,
    };
  }
  return agg;
};

// Containers are keyed unconditionally (even when settled) so their key never
// flips to hast-util's positional fallback as the frontier passes — which would
// remount the subtree. The `data-sd-animating` marker keeps containers with
// active/pending descendants re-rendering even while their source position is
// unchanged (the memoized markdown components otherwise skip them).
const applyContainerCascade = (el: Element, agg: Aggregate, ctx: Ctx): void => {
  el.properties = { ...el.properties, "data-sd-key": keyPrefix(el, "c", ctx) };
  if (agg.hasActive || agg.hasPending) {
    el.properties = { ...el.properties, "data-sd-animating": true };
  }
  if (agg.hasSettled) {
    return;
  }
  if (agg.hasActive) {
    el.properties = { ...el.properties, "data-sd-appear": true };
    appendStyle(el, `--sd-delay:${agg.minActiveDelay}ms`);
    if (el.tagName === "li" && ctx.plan) {
      el.properties["data-sd-animate-marker"] = true;
      appendStyle(
        el,
        `--sd-marker-duration:${ctx.config.duration}ms;--sd-marker-easing:${ctx.config.easing}`
      );
      for (const c of el.children) {
        if (c.type === "element") {
          const input = c.tagName === "input" ? c : findCheckbox(c);
          if (input) {
            input.properties["data-sd-animate"] = true;
            appendStyle(input, animationStyle(agg.minActiveDelay, ctx.config));
          }
        }
      }
    }
    return;
  }
  if (agg.hasPending) {
    el.properties = { ...el.properties, "data-sd-hidden": true };
  }
};

const processChildren = (parent: Parent, ctx: Ctx): Aggregate => {
  const agg = emptyAggregate();
  let i = 0;
  while (i < parent.children.length) {
    const child = parent.children[i];
    if (child.type === "text") {
      const { agg: childAgg, consumed } = processText(child, parent, i, ctx);
      fold(agg, childAgg);
      i += consumed;
      continue;
    }
    if (child.type === "element") {
      if (isAtomic(child)) {
        fold(agg, processAtomic(child, ctx));
      } else {
        // Track link depth so processText can merge whitespace inside <a>.
        const wasLink = child.tagName === "a";
        if (wasLink) {
          ctx.linkDepth++;
        }
        const childAgg = processChildren(child, ctx);
        if (wasLink) {
          ctx.linkDepth--;
        }
        if (ctx.plan) {
          applyContainerCascade(child, childAgg, ctx);
        }
        fold(agg, childAgg);
      }
    }
    i += 1;
  }
  return agg;
};

/**
 * Non-mutating: enumerate the ordered animatable segments of a tree. Pass
 * `baseOrdinal` to place this tree's segments in a larger global ordinal space
 * (Streamdown renders one tree per block).
 */
export const enumerateSegments = (
  tree: Root,
  config: AnimateConfig = DEFAULT_ANIMATE_CONFIG,
  baseOrdinal = 0
): SegmentInfo[] => {
  const ctx: Ctx = {
    config,
    plan: null,
    counter: { value: baseOrdinal },
    segments: [],
    fallbackKey: { value: baseOrdinal },
    linkDepth: 0,
  };
  processChildren(tree, ctx);
  return ctx.segments;
};

/**
 * Mutating: wrap/annotate the tree according to the animation plan. `baseOrdinal`
 * offsets this tree's local ordinals into the global plan's ordinal space.
 */
export const applyAnimation = (
  tree: Root,
  plan: AnimationPlan,
  config: AnimateConfig = DEFAULT_ANIMATE_CONFIG,
  baseOrdinal = 0
): void => {
  const ctx: Ctx = {
    config,
    plan,
    counter: { value: baseOrdinal },
    segments: [],
    fallbackKey: { value: baseOrdinal },
    linkDepth: 0,
  };
  processChildren(tree, ctx);
};
