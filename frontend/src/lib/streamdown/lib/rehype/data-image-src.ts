import type { Element, Root } from "hast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";

/**
 * Raster image MIME types allowed in a `data:` image source.
 *
 * `image/svg+xml` is deliberately excluded: an SVG document can carry
 * `<script>`, event handlers and external references, so a data-URL SVG is
 * script injection with an extra step.
 */
const SAFE_DATA_IMAGE =
  /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[A-Za-z0-9+/=]+$/;

/**
 * rehype plugin — narrows the `data:` image sources that `rehype-sanitize`'s
 * schema admits down to base64 raster images.
 *
 * The sanitize schema cannot express "data: but only `data:image/*`"
 * (its protocol list is matched per scheme, so allowing `data` also admits
 * `data:text/html`), so the schema permits the whole scheme and this plugin
 * removes what is not a raster image. Runs after `rehype-sanitize` and before
 * `rehype-harden`, which does the final `allowDataImages` check.
 */
export const rehypeDataImageSrc: Plugin<[], Root> = () => (tree: Root) => {
  visit(tree, "element", (node: Element) => {
    if (node.tagName !== "img") return;
    const { src } = node.properties;
    if (typeof src !== "string") return;
    if (src.startsWith("data:") && !SAFE_DATA_IMAGE.test(src.trim())) {
      node.properties.src = undefined;
    }
  });
};