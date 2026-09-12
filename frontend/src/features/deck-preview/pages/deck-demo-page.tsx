import { ArrowLeftIcon, ArrowRightIcon, MoonIcon, SunIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/**
 * PoC — Slidev-style slide renderer (no iframe, no reveal.js).
 *
 * One slide = a sanitized HTML fragment + theme token CSS, rendered as plain
 * DOM inside a FIXED 16:9 canvas scaled with a single CSS transform — the
 * same approach as Slidev's `SlideContainer.vue`
 * (scale = min(containerW/canvasW, containerH/canvasH)). Payload is a few KB
 * per slide instead of the 300 KB data:-URL iframe that froze the window.
 *
 * Demo data is authored here; the production path feeds the same shape from
 * the planned `office_read_deck` op (Rust splits <section>s + theme css).
 */

// ── demo deck ───────────────────────────────────────────────────────────────

interface DemoSlide {
  title: string;
  bodyHtml: string;
}

interface DemoTheme {
  id: string;
  name: string;
  dark: boolean;
  /** raw CSS custom properties — mirrors kawai's template pack tokens */
  tokens: string;
}

const CONSULTING_TOKENS = `
  --bg:#ffffff; --surface:#f5f7fa; --border:rgba(17,18,22,.08);
  --text-1:#1a2b4a; --text-2:#55596a; --accent:#0e7c7b; --radius:12px;
  --font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
`;

const DARK_PITCH_TOKENS = `
  --bg:#0d1117; --surface:#161b22; --border:rgba(230,237,243,.12);
  --text-1:#e6edf3; --text-2:#8b949e; --accent:#ff5c35; --radius:12px;
  --font-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
`;

const SLIDES: DemoSlide[] = [
  {
    title: "Kawai deck preview — native DOM, no iframe",
    bodyHtml: `<span class='kicker'>PROOF OF CONCEPT</span>
<p class='lede'>This slide is plain DOM inside the app webview — the same markup <code>office_create_deck</code> stores, minus reveal.js.</p>
<div class='divider-accent'></div>
<p>Use ← / → (or the buttons) to navigate. Switch the theme to see the token swap.</p>`,
  },
  {
    title: "Numbers are the story",
    bodyHtml: `<div class='grid g3'>
<div class='card card-accent'><span class='kicker'>WEIGHT</span><span class='big-number'>~4KB</span><p>per slide payload, vs ~300KB iframe</p></div>
<div class='card'><span class='kicker'>CANVAS</span><span class='big-number'>16:9</span><p>fixed 980px canvas, CSS-scaled</p></div>
<div class='card'><span class='kicker'>RUNTIME</span><span class='big-number'>0</span><p>no reveal.js, no nested webview</p></div>
</div>`,
  },
  {
    title: "Same vocabulary as the real deck",
    bodyHtml: `<div class='grid g2'>
<div class='card'><h3>Cards & grids</h3><p><code>card</code>, <code>card-accent</code>, <code>grid g2/g3</code> — identical class names to the stored deck HTML.</p></div>
<div class='card'><h3>Text primitives</h3><p><code>kicker</code>, <code>lede</code>, <code>big-number</code>, <code>blockquote</code> all styled by the theme tokens.</p></div>
</div>
<blockquote>Fidelity comes from reusing the template CSS, not from running the deck runtime.</blockquote>`,
  },
  {
    title: "Next step: office_read_deck feeds this page",
    bodyHtml: `<p class='lede'>Rust already splits the stored deck into sanitized <code>&lt;section&gt;</code> fragments + theme CSS.</p>
<ul><li>op returns <code>{title, template, themeCss, slides[]}</code></li>
<li>this component swaps demo data for real slides — nothing else changes</li>
<li>full reveal.js deck stays available via "open in browser"</li></ul>`,
  },
];

const THEMES: DemoTheme[] = [
  { id: "consulting-clean", name: "Consulting Clean", dark: false, tokens: CONSULTING_TOKENS },
  { id: "dark-pitch", name: "Dark Pitch", dark: true, tokens: DARK_PITCH_TOKENS },
];

// ── fixed 16:9 canvas (Slidev: canvasWidth 980) ─────────────────────────────

const CANVAS_W = 980;
const CANVAS_H = 551;

/** The deck-scope stylesheet — the same class vocabulary the Rust renderer
 *  emits (a trimmed DECK_LAYOUT_CSS) + the active theme's tokens. */
function deckStyles(theme: DemoTheme): string {
  return `
.deck-demo-scope{${theme.tokens}
  position:relative;width:${CANVAS_W}px;height:${CANVAS_H}px;
  background:var(--bg);color:var(--text-1);font-family:var(--font-sans);
  padding:56px 64px;overflow:hidden;box-sizing:border-box;
}
.deck-demo-scope h1{font-size:40px;line-height:1.1;font-weight:800;margin:0 0 18px;letter-spacing:-.02em;color:var(--text-1)}
.deck-demo-scope h3{font-size:22px;font-weight:600;margin:0 0 8px;color:var(--text-1)}
.deck-demo-scope p{font-size:17px;line-height:1.55;margin:0 0 12px;color:var(--text-2)}
.deck-demo-scope ul{margin:8px 0 0;padding-left:22px}
.deck-demo-scope li{font-size:16px;line-height:1.7;color:var(--text-2)}
.deck-demo-scope code{background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1px 6px;font-size:.85em;color:var(--text-1)}
.deck-demo-scope blockquote{margin:20px 0 0;padding:6px 0 6px 18px;border-left:3px solid var(--accent);font-size:19px;color:var(--text-1);font-style:italic}
.deck-demo-scope .kicker{display:inline-block;font-size:12px;font-weight:700;letter-spacing:.14em;color:var(--accent);margin-bottom:14px}
.deck-demo-scope .lede{font-size:21px;line-height:1.45;color:var(--text-1)}
.deck-demo-scope .big-number{display:block;font-size:56px;font-weight:800;line-height:1.05;color:var(--accent);margin-bottom:8px}
.deck-demo-scope .divider-accent{width:64px;height:3px;background:var(--accent);border-radius:2px;margin:18px 0}
.deck-demo-scope .grid{display:grid;gap:16px;margin-top:8px}
.deck-demo-scope .grid.g2{grid-template-columns:1fr 1fr}
.deck-demo-scope .grid.g3{grid-template-columns:1fr 1fr 1fr}
.deck-demo-scope .card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px}
.deck-demo-scope .card p{margin:6px 0 0;font-size:14px}
.deck-demo-scope .card .kicker{margin-bottom:8px}
.deck-demo-scope .card .big-number{font-size:40px}
`;
}

// ── scale hook (Slidev SlideContainer: min(w/W, h/H)) ───────────────────────

function useCanvasScale() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const el = containerRef.current;
    if (el == null) return;
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect();
      if (width > 0 && height > 0) setScale(Math.min(width / CANVAS_W, height / CANVAS_H));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { containerRef, scale };
}

// ── page ────────────────────────────────────────────────────────────────────

export function DeckDemoPage({ onBack }: { onBack: () => void }) {
  const [index, setIndex] = useState(0);
  const [themeId, setThemeId] = useState(THEMES[0].id);
  const theme = useMemo(() => THEMES.find((t) => t.id === themeId) ?? THEMES[0], [themeId]);
  const { containerRef, scale } = useCanvasScale();

  const go = useCallback(
    (delta: number) => setIndex((i) => Math.min(SLIDES.length - 1, Math.max(0, i + delta))),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go]);

  const slide = SLIDES[index] ?? SLIDES[0];

  return (
    <div className="bg-background text-foreground flex h-dvh flex-col overflow-hidden">
      {/* header */}
      <div className="border-border/60 flex items-center gap-3 border-b px-4 py-2">
        <Button onClick={onBack} size="sm" variant="ghost">
          Back
        </Button>
        <span className="text-muted-foreground font-mono text-xs uppercase">Deck preview · PoC</span>
        <div className="flex-1" />
        <Button
          onClick={() => setThemeId(theme.id === THEMES[0].id ? THEMES[1].id : THEMES[0].id)}
          size="sm"
          variant="outline"
        >
          {theme.dark ? <SunIcon className="size-3.5" /> : <MoonIcon className="size-3.5" />}
          {theme.name}
        </Button>
      </div>

      {/* canvas */}
      <div ref={containerRef} className="relative min-h-0 flex-1 overflow-hidden">
        <style dangerouslySetInnerHTML={{ __html: deckStyles(theme) }} />
        <div
          className="absolute top-1/2 left-1/2 shadow-lg"
          style={{
            width: CANVAS_W,
            height: CANVAS_H,
            transform: `translate(-50%, -50%) scale(${scale})`,
          }}
        >
          {/* The slide — plain DOM, no iframe. Fragment is sanitized server-side
              in the production path; here it is authored demo data. */}
          <div className="deck-demo-scope">
            <h1>{slide.title}</h1>
            <div dangerouslySetInnerHTML={{ __html: slide.bodyHtml }} />
          </div>
        </div>
      </div>

      {/* nav rail */}
      <div className="border-border/60 flex items-center justify-center gap-4 border-t px-4 py-2">
        <Button disabled={index === 0} onClick={() => go(-1)} size="icon" variant="ghost">
          <ArrowLeftIcon className="size-4" />
        </Button>
        <div className="flex items-center gap-1.5">
          {SLIDES.map((_, i) => (
            <button
              aria-label={`Slide ${i + 1}`}
              className={
                i === index
                  ? "bg-primary size-2 rounded-full"
                  : "bg-muted-foreground/30 hover:bg-muted-foreground/60 size-2 rounded-full"
              }
              key={i}
              onClick={() => setIndex(i)}
              type="button"
            />
          ))}
        </div>
        <span className="text-muted-foreground font-mono text-xs tabular-nums">
          {index + 1} / {SLIDES.length}
        </span>
        <Button disabled={index === SLIDES.length - 1} onClick={() => go(1)} size="icon" variant="ghost">
          <ArrowRightIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
