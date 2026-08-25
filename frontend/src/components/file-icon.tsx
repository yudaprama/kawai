import { getIconNameForFileName } from "@/assets/utils";
import { fileExtension, IMAGE_EXTENSIONS } from "@/lib/file-types";

// Simple per-module cache for generated SVG URLs to avoid repeated CDN fetches
const ICON_URL_CACHE = new Map<string, string>();

export const FILE_ICON_CDN = "https://cdn.jsdelivr.net/npm/@lobehub/assets-fileicon@1.0.0/assets";

export interface FileIconProps {
  name: string;
  className?: string;
}

export function FileIcon({ name, className = "size-4 shrink-0" }: FileIconProps) {
  const ext = fileExtension(name);

  if (IMAGE_EXTENSIONS.has(ext)) {
    return <div className={`bg-muted shrink-0 rounded-md ${className ?? ""}`} />;
  }

  const iconName = getIconNameForFileName(name);
  let src = ICON_URL_CACHE.get(iconName);
  if (!src) {
    src = `${FILE_ICON_CDN}/${iconName}.svg`;
    ICON_URL_CACHE.set(iconName, src);
  }

  return <img src={src} alt="" loading="lazy" className={className} />;
}
