import { useSyncExternalStore } from "react";
import uiIcons from "@/assets/ui-icons.json";

const LUCIDE_CDN = "https://unpkg.com/lucide-static@latest/icons";

// Shared in-memory cache: name → SVG markup string
const cache = new Map<string, string>();

// Subscriber noop — we never need re-renders, just cache hits
const noop = () => () => {};

function iconSrc(name: string): string {
  const mapped = uiIcons[name as keyof typeof uiIcons];
  return `${LUCIDE_CDN}/${(mapped ?? name).replace("lucide/", "")}.svg`;
}

async function fetchSvg(name: string): Promise<string> {
  if (cache.has(name)) return cache.get(name)!;
  const res = await fetch(iconSrc(name));
  const text = await res.text();
  // Strip the fixed width/height from Lucide SVGs so we can size via className
  const cleaned = text
    .replace(/<svg([^>]*)>/, (_m, attrs: string) => {
      const sansDimensions = attrs
        .replace(/\bwidth="[^"]*"/, "")
        .replace(/\bheight="[^"]*"/, "");
      return `<svg${sansDimensions}>`;
    })
    // Lucide static SVGs use stroke="currentColor" — keep it, it inherits
    .replace(/stroke="[^"]*"/, 'stroke="currentColor"');
  cache.set(name, cleaned);
  return cleaned;
}

export interface IconProps {
  name: string;
  className?: string;
}

// Pre-warm the most common icons
const WARM_LIST = [
  "loader-circle", "check", "x", "plus", "trash", "search", "pencil",
  "chevron-down", "chevron-right", "external-link", "wrench", "copy",
];

for (const n of WARM_LIST) {
  fetchSvg(n).catch(() => {});
}

export function Icon({ name, className = "size-4 shrink-0" }: IconProps) {
  const svg = useSyncExternalStore(noop, () => cache.get(name) ?? null);

  // Sync first paint: if cache is cold, render <img> fallback (no currentColor)
  if (!svg) {
    return (
      <img
        src={iconSrc(name)}
        alt=""
        loading="lazy"
        className={`pointer-events-none object-contain dark:invert ${className}`}
      />
    );
  }

  return (
    <span
      className={className}
      aria-hidden="true"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
