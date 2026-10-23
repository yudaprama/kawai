"use client";

import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math";
import type { Pluggable } from "unified";

// katex styling: injected HERE (when this lazily-loaded module first runs)
// instead of a render-blocking <head> stylesheet in index.html — first paint
// must never wait on the CDN. Version MUST match the katex pin in the
// importmap in frontend/index.html.
if (typeof document !== "undefined" && !document.querySelector("link[data-katex-css]")) {
  const katexCss = document.createElement("link");
  katexCss.rel = "stylesheet";
  katexCss.href = "https://esm.sh/katex@0.18.4/dist/katex.min.css";
  katexCss.setAttribute("data-katex-css", "");
  document.head.appendChild(katexCss);
}

/**
 * Plugin for math rendering (KaTeX)
 */
export interface MathPlugin {
  /**
   * Get CSS styles path for math rendering
   */
  getStyles?: () => string;
  name: "katex";
  /**
   * Rehype plugin for rendering math
   */
  rehypePlugin: Pluggable;
  /**
   * Remark plugin for parsing math syntax
   */
  remarkPlugin: Pluggable;
  type: "math";
}

/**
 * Options for creating a math plugin
 */
export interface MathPluginOptions {
  /**
   * KaTeX error color
   * @default "var(--color-muted-foreground)"
   */
  errorColor?: string;
  /**
   * Enable single dollar sign for inline math ($...$)
   * @default false
   */
  singleDollarTextMath?: boolean;
}

/**
 * Create a math plugin with optional configuration
 */
export function createMathPlugin(options: MathPluginOptions = {}): MathPlugin {
  const remarkMathPlugin: Pluggable = [
    remarkMath,
    { singleDollarTextMath: options.singleDollarTextMath ?? false },
  ];

  // P1-5: mirror desktop/src/components/MarkdownContent.tsx:238 — never throw on bad math
  const rehypeKatexPlugin: Pluggable = [
    rehypeKatex,
    {
      errorColor: options.errorColor ?? "var(--color-muted-foreground)",
      throwOnError: false,
      strict: false,
    },
  ];

  return {
    name: "katex",
    type: "math",
    remarkPlugin: remarkMathPlugin,
    rehypePlugin: rehypeKatexPlugin,
    getStyles() {
      // Users should import katex CSS in their app:
      // import "katex/dist/katex.min.css";
      // This method provides the path for reference
      return "katex/dist/katex.min.css";
    },
  };
}

/**
 * Pre-configured math plugin with default settings
 */
export const math = createMathPlugin();
