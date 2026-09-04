import type { ReactNode } from "react";
import { parse, isRecord } from "./shared";

/** Pexels photos/videos → thumbnail grid. Handles both `photos` and `videos`. */
export function renderMedia(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;

  type MediaItem = { thumb: string; href?: string; credit?: string };

  let items: MediaItem[] = [];
  if (Array.isArray(d.photos)) {
    items = d.photos.flatMap((p): MediaItem[] => {
      if (!isRecord(p) || !isRecord(p.src)) return [];
      const thumb =
        (typeof p.src.medium === "string" && p.src.medium) ||
        (typeof p.src.tiny === "string" && p.src.tiny) ||
        "";
      if (!thumb) return [];
      return [
        {
          thumb,
          href: typeof p.url === "string" ? p.url : undefined,
          credit:
            typeof p.photographer === "string" ? p.photographer : undefined,
        },
      ];
    });
  } else if (Array.isArray(d.videos)) {
    items = d.videos.flatMap((v): MediaItem[] => {
      if (!isRecord(v) || typeof v.image !== "string") return [];
      const credit = isRecord(v.user) && typeof v.user.name === "string"
        ? v.user.name
        : undefined;
      return [
        {
          thumb: v.image,
          href: typeof v.url === "string" ? v.url : undefined,
          credit,
        },
      ];
    });
  }

  if (items.length === 0) return null;

  return (
    <div className="not-prose grid grid-cols-2 gap-2 sm:grid-cols-3">
      {items.slice(0, 9).map((it, i) => {
        const inner = (
          <>
            <img
              src={it.thumb}
              alt={it.credit ?? ""}
              loading="lazy"
              className="aspect-video w-full rounded-md object-cover"
            />
            {it.credit && (
              <span className="absolute inset-x-0 bottom-0 truncate rounded-b-md bg-black/50 px-1.5 py-0.5 text-[11px] text-white">
                {it.credit}
              </span>
            )}
          </>
        );
        return it.href ? (
          <a
            key={i}
            href={it.href}
            target="_blank"
            rel="noreferrer"
            className="group relative block"
          >
            {inner}
          </a>
        ) : (
          <div key={i} className="relative">
            {inner}
          </div>
        );
      })}
    </div>
  );
}
