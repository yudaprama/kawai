/**
 * Deck markdown rendering — the unified/remark pipeline (the same ecosystem
 * streamdown uses), shared by every deck surface. Raw HTML never passes
 * through (rehype-sanitize with the default schema); URLs are not linkified
 * (no autolink plugin).
 *
 * The pipeline modules resolve from esm.sh at runtime (vite.config.ts
 * rollupOptions.external), so they load behind a dynamic import: a static
 * import would put them into the entry chunk, where a CDN failure bricks the
 * whole app at boot (see components/shared/lazy-streamdown.tsx). Await
 * `deckMarkdownReady()` before rendering; the render fns throw before that.
 */

/** Only processSync is consumed — the structural shape keeps the (deeply
 *  generic) unified chain types out of this module. */
interface DeckPipeline {
  block: { processSync(markdown: string): { toString(): string } };
  inline: { processSync(value: string): { toString(): string } };
}

let deck: DeckPipeline | null = null;
let readyPromise: Promise<void> | null = null;

export function deckMarkdownReady(): Promise<void> {
  readyPromise ??= (async () => {
    const [
      { unified },
      remarkParse,
      remarkGfm,
      remarkRehype,
      { default: rehypeSanitize, defaultSchema },
      rehypeStringify,
    ] = await Promise.all([
      import("unified"),
      import("remark-parse"),
      import("remark-gfm"),
      import("remark-rehype"),
      import("rehype-sanitize"),
      import("rehype-stringify"),
    ]);

    deck = {
      inline: unified()
        .use(remarkParse.default)
        .use(remarkRehype.default, { allowDangerousHtml: false })
        .use(rehypeStringify.default),
      block: unified()
        .use(remarkParse.default)
        .use(remarkGfm.default, { singleTilde: false })
        .use(remarkRehype.default, { allowDangerousHtml: false })
        .use(rehypeSanitize, defaultSchema)
        .use(rehypeStringify.default),
    };
  })();
  return readyPromise;
}

/** Full block renderer: GFM (tables, strikethrough, task lists) → sanitized
 *  HTML string. Equivalent of `MarkdownIt({ html: false, linkify: false }).render`. */
export function renderDeckBlock(markdown: string): string {
  if (deck == null) throw new Error("deck markdown pipeline not loaded — await deckMarkdownReady() first");
  return String(deck.block.processSync(markdown));
}

/** Inline renderer: emphasis + inline code only (no links, no headings, no
 *  raw HTML). Equivalent of the old zero-preset
 *  `MarkdownIt("zero").enable(["emphasis", "backticks"]).renderInline`.
 *  Implemented as a block pass with GFM off, then the wrapping <p> stripped. */
export function renderDeckInline(value: string): string {
  if (deck == null) throw new Error("deck markdown pipeline not loaded — await deckMarkdownReady() first");
  const html = String(deck.inline.processSync(value));
  // Strip the single paragraph wrapper the block pipeline adds around
  // inline-only content (markdown-it's renderInline has no such wrapper).
  return html.replace(/^<p>/, "").replace(/<\/p>\n?$/, "");
}
