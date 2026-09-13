import uiIcons from "@/assets/ui-icons.json";

const LUCIDE_CDN = "https://unpkg.com/lucide-static@latest/icons";

// Pre-module cache for resolved CDN URLs
const URL_CACHE = new Map<string, string>();

function iconSrc(name: string): string {
  let src = URL_CACHE.get(name);
  if (!src) {
    const mapped = uiIcons[name as keyof typeof uiIcons];
    src = `${LUCIDE_CDN}/${(mapped ?? name).replace("lucide/", "")}.svg`;
    URL_CACHE.set(name, src);
  }
  return src;
}

export interface IconProps {
  name: string;
  className?: string;
}

export function Icon({ name, className = "size-4 shrink-0" }: IconProps) {
  return <img src={iconSrc(name)} alt="" loading="lazy" className={className} />;
}
