import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

/**
 * Deck markdown rendering — the unified/remark pipeline (the same ecosystem
 * streamdown uses), shared by every deck surface. Raw HTML never passes
 * through (rehype-sanitize with the default schema); URLs are not linkified
 * (no autolink plugin).
 */

/** Full block renderer: GFM (tables, strikethrough, task lists) → sanitized
 *  HTML string. Equivalent of `MarkdownIt({ html: false, linkify: false }).render`. */
const deckBlock = unified()
  .use(remarkParse)
  .use(remarkGfm, { singleTilde: false })
  .use(remarkRehype, { allowDangerousHtml: false })
  .use(rehypeSanitize, defaultSchema)
  .use(rehypeStringify);

export function renderDeckBlock(markdown: string): string {
  return String(deckBlock.processSync(markdown));
}

/** Inline renderer: emphasis + inline code only (no links, no headings, no
 *  raw HTML). Equivalent of the old zero-preset
 *  `MarkdownIt("zero").enable(["emphasis", "backticks"]).renderInline`.
 *  Implemented as a block pass with GFM off, then the wrapping <p> stripped. */
const deckInline = unified().use(remarkParse).use(remarkRehype, { allowDangerousHtml: false }).use(rehypeStringify);

export function renderDeckInline(value: string): string {
  const html = String(deckInline.processSync(value));
  // Strip the single paragraph wrapper the block pipeline adds around
  // inline-only content (markdown-it's renderInline has no such wrapper).
  return html.replace(/^<p>/, "").replace(/<\/p>\n?$/, "");
}
