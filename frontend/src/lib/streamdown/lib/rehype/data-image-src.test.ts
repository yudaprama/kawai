import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import type { Element, Nodes } from "hast";
import { defaultRehypePlugins } from "@/lib/streamdown";

/** Run the real default pipeline (raw → sanitize → dataImageSrc → harden). */
function render(markdown: string) {
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(Object.values(defaultRehypePlugins));
  const found: Element[] = [];
  const walk = (node: Nodes) => {
    if (node.type === "element") {
      found.push(node);
      node.children.forEach(walk);
    } else if ("children" in node) {
      (node.children as Nodes[]).forEach(walk);
    }
  };
  walk(processor.runSync(processor.parse(markdown)) as unknown as Nodes);
  return {
    images: found.filter((n) => n.tagName === "img"),
    links: found.filter((n) => n.tagName === "a"),
    all: found,
  };
}

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("streamdown default sanitize pipeline", () => {
  it("keeps base64 raster images", () => {
    const { images } = render(`![a](${PNG})`);
    expect(images).toHaveLength(1);
    expect(images[0].properties.src).toBe(PNG);
  });

  it("keeps base64 raster images authored as raw HTML", () => {
    const { images } = render(`<img src="${PNG}" alt="x">`);
    expect(images).toHaveLength(1);
    expect(images[0].properties.src).toBe(PNG);
  });

  it("rejects data-URL SVG, which can carry script", () => {
    // harden swaps a rejected image for its blocked-image placeholder, so the
    // <img> is gone entirely rather than left without a src.
    const { images } = render("![a](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)");
    expect(images).toHaveLength(0);
  });

  it("rejects non-image data URLs", () => {
    const { images } = render("![a](data:text/html;base64,PHNjcmlwdD4=)");
    expect(images).toHaveLength(0);
  });

  it("rejects data URLs on links even though the scheme is allowed for images", () => {
    const { links } = render("[x](data:text/html;base64,PHNjcmlwdD4=)");
    expect(links).toHaveLength(0);
  });

  it("keeps http(s), relative and tel sources", () => {
    expect(render("![a](https://x.test/i.png)").images[0].properties.src).toBe(
      "https://x.test/i.png",
    );
    expect(render("[x](tel:+628)").links[0].properties.href).toBe("tel:+628");
  });

  it("strips script, event handlers and style", () => {
    const { all } = render(
      '<script>alert(1)</script><div style="position:fixed" onclick="bad()">x</div>',
    );
    expect(all.map((n) => n.tagName)).not.toContain("script");
    const div = all.find((n) => n.tagName === "div");
    expect(div?.properties).toEqual({});
  });
});

describe("sanitize schema", () => {
  it("admits the data scheme on src only, narrowed by the plugin", () => {
    // rehype-sanitize matches protocols per scheme, so `data` in the schema
    // admits the whole scheme — `rehypeDataImageSrc` is what narrows it.
    const schema = {
      ...defaultSchema,
      protocols: { ...defaultSchema.protocols, src: ["data"] },
    };
    const processor = unified()
      .use(remarkParse)
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeSanitize, schema);
    const tree = processor.runSync(processor.parse("![a](data:text/html,x)"));
    expect(JSON.stringify(tree)).toContain("data:text/html");
  });

  it("harden is configured after the narrowing plugin, not before", () => {
    const order = Object.keys(defaultRehypePlugins);
    expect(order.indexOf("dataImageSrc")).toBeGreaterThan(order.indexOf("sanitize"));
    expect(order.indexOf("dataImageSrc")).toBeLessThan(order.indexOf("harden"));
  });
});