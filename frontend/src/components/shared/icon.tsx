import { useEffect, useState } from "react";
import uiIcons from "@/assets/ui-icons.json";

const LUCIDE_CDN = "https://unpkg.com/lucide-static@latest/icons";

// Shared in-memory cache: name → SVG markup string
const cache = new Map<string, string>();

function iconSrc(name: string): string {
  const mapped = uiIcons[name as keyof typeof uiIcons];
  return `${LUCIDE_CDN}/${(mapped ?? name).replace("lucide/", "")}.svg`;
}

async function fetchSvg(name: string): Promise<string> {
  if (cache.has(name)) return cache.get(name)!;
  const res = await fetch(iconSrc(name), { redirect: "follow" });
  const text = await res.text();
  const cleaned = text
    .replace(/<svg([^>]*)>/, (_m, attrs: string) => {
      const sansDimensions = attrs
        .replace(/\bwidth="[^"]*"/, "")
        .replace(/\bheight="[^"]*"/, "");
      return `<svg${sansDimensions}>`;
    })
    .replace(/stroke="[^"]*"/, 'stroke="currentColor"');
  cache.set(name, cleaned);
  return cleaned;
}

// Pre-warm common icons
for (const n of [
  "loader-circle", "check", "x", "plus", "trash", "search", "pencil",
  "chevron-down", "chevron-right", "external-link", "wrench", "copy",
]) {
  fetchSvg(n).catch(() => {});
}

export interface IconProps {
  name: string;
  className?: string;
}

export function Icon({ name, className = "size-4 shrink-0" }: IconProps) {
  const [svg, setSvg] = useState(() => cache.get(name) ?? null);

  useEffect(() => {
    if (cache.has(name)) {
      setSvg(cache.get(name)!);
      return;
    }
    let cancelled = false;
    fetchSvg(name).then((s) => {
      if (!cancelled) setSvg(s);
    });
    return () => {
      cancelled = true;
    };
  }, [name]);

  if (svg) {
    return (
      <span
        className={className}
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }

  return (
    <img
      src={iconSrc(name)}
      alt=""
      loading="lazy"
      className={`pointer-events-none object-contain ${className}`}
    />
  );
}
