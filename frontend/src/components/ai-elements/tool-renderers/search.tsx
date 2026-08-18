import type { ReactNode } from "react";
import { parse, isRecord, str, Footnote } from "./shared";
import { GlobeIcon, SparklesIcon } from "lucide-react";

type Hit = {
  title?: string;
  url?: string;
  body?: string;
  site?: string;
  age?: string;
  favicon?: string;
  thumbnail?: string;
};

function hostname(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return undefined;
  }
}

function toHits(d: unknown): Hit[] | null {
  if (!isRecord(d) || !Array.isArray(d.results)) return null;
  return d.results.flatMap((r): Hit[] => {
    if (!isRecord(r)) return [];
    const url = str(r.url) ?? str(r.link);
    if (!url) return [];
    return [
      {
        title: str(r.title),
        url,
        body: str(r.snippet) ?? str(r.description) ?? str(r.content),
        site: str(r.site_name) ?? str(r.site_long_name) ?? hostname(url),
        age: str(r.age),
        favicon: str(r.favicon),
        thumbnail: str(r.thumbnail),
      },
    ];
  });
}

function Favicon({ src }: { src?: string }) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        loading="lazy"
        className="size-4 shrink-0 rounded-sm object-contain"
      />
    );
  }
  return <GlobeIcon className="size-4 shrink-0 text-muted-foreground" />;
}

export function renderWebSearch(output: unknown): ReactNode {
  const d = parse(output);
  const hits = toHits(d);
  if (!hits || hits.length === 0) return null;
  const overview = isRecord(d) ? str(d.ai_overview) : undefined;

  return (
    <div className="not-prose space-y-2">
      {overview && (
        <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-3">
          <div className="flex items-center gap-1.5 text-primary text-[11px] font-medium uppercase tracking-wide">
            <SparklesIcon className="size-3" />
            AI Overview
          </div>
          <p className="text-[13px] leading-relaxed text-foreground">
            {overview}
          </p>
        </div>
      )}
      <div className="space-y-1.5">
        {hits.slice(0, 8).map((h, i) => {
          const meta = [h.site, h.age].filter(Boolean).join(" · ");
          return (
            <a
              key={i}
              href={h.url}
              target="_blank"
              rel="noreferrer"
              className="block rounded-md border bg-muted/20 px-3 py-2 transition-colors hover:bg-muted/50"
            >
              <div className="flex items-center gap-1.5 text-muted-foreground text-[11px]">
                <Favicon src={h.favicon ?? h.thumbnail} />
                {meta && <span className="truncate">{meta}</span>}
              </div>
              <div className="mt-0.5 truncate font-medium text-[13px] text-primary hover:underline">
                {h.title ?? h.url}
              </div>
              {h.body && (
                <div className="mt-0.5 line-clamp-2 text-muted-foreground text-xs">
                  {h.body}
                </div>
              )}
            </a>
          );
        })}
      </div>
      {hits.length > 8 && <Footnote>+{hits.length - 8} more</Footnote>}
    </div>
  );
}

export function renderWebSearchSuggest(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.suggestions)) return null;
  const items = d.suggestions.filter((s): s is string => typeof s === "string");
  if (items.length === 0) return null;
  return (
    <div className="not-prose flex flex-wrap gap-1">
      {items.slice(0, 12).map((s, i) => (
        <span
          key={i}
          className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs"
        >
          {s}
        </span>
      ))}
    </div>
  );
}
