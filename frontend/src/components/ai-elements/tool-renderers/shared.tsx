import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export { isRecord } from "@/lib/utils";
import { MapPinIcon } from "lucide-react";

export function parse(output: unknown): unknown {
  if (typeof output !== "string") return output;
  const trimmed = output.trim();
  if (!trimmed) return null;
  if (trimmed[0] === "{" || trimmed[0] === "[") {
    try {
      return JSON.parse(trimmed);
    } catch {
      return output;
    }
  }
  return output;
}

export function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

export function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

export function fmtNum(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export const TextCard = ({ className, children }: { className?: string; children: ReactNode }) => (
  <div className={cn("not-prose space-y-2", className)}>{children}</div>
);

export const Verse = ({ children }: { children: ReactNode }) => (
  <blockquote className="border-l-2 border-primary/40 pl-4 text-[15px] leading-relaxed text-foreground">
    {children}
  </blockquote>
);

export const Footnote = ({ children }: { children: ReactNode }) => (
  <p className="text-muted-foreground text-xs">{children}</p>
);

export type CardItem = {
  title: string;
  subtitle?: string;
  image?: string;
  href?: string;
  meta?: string;
};

export const CardList = ({ items }: { items: CardItem[] }) => (
  <div className="not-prose space-y-2">
    {items.slice(0, 8).map((it, i) => {
      const body = (
        <div className="flex gap-3">
          {it.image && (
            <img
              src={it.image}
              alt=""
              loading="lazy"
              className="h-16 w-12 shrink-0 rounded object-cover"
            />
          )}
          <div className="min-w-0 space-y-0.5">
            <div className="truncate font-medium text-sm text-foreground">
              {it.title}
            </div>
            {it.subtitle && (
              <div className="line-clamp-2 text-muted-foreground text-xs">
                {it.subtitle}
              </div>
            )}
            {it.meta && (
              <div className="text-muted-foreground text-[11px]">{it.meta}</div>
            )}
          </div>
        </div>
      );
      return it.href ? (
        <a
          key={i}
          href={it.href}
          target="_blank"
          rel="noreferrer"
          className="block rounded-md border bg-muted/30 p-2 transition-colors hover:bg-muted/60"
        >
          {body}
        </a>
      ) : (
        <div key={i} className="rounded-md border bg-muted/30 p-2">
          {body}
        </div>
      );
    })}
  </div>
);

export function cards(items: CardItem[] | null): ReactNode {
  return items && items.length ? <CardList items={items} /> : null;
}

export const ParamChips = ({ names, tone }: { names: string[]; tone: "req" | "opt" }) =>
  names.length ? (
    <>
      {names.map((p) => (
        <span
          key={p}
          className={cn(
            "rounded px-1.5 py-0.5 font-mono text-[11px]",
            tone === "req"
              ? "bg-primary/10 text-primary"
              : "bg-muted text-muted-foreground"
          )}
        >
          {p}
          {tone === "opt" ? "?" : ""}
        </span>
      ))}
    </>
  ) : null;

export type Metric = { label: string; value: string; sub?: string; delta?: string; up?: boolean };

export const MetricGrid = ({ items }: { items: Metric[] }) => (
  <div className="not-prose grid grid-cols-2 gap-2 sm:grid-cols-3">
    {items.map((m, i) => (
      <div key={i} className="rounded-md border bg-muted/40 p-3">
        <div className="text-muted-foreground text-xs">{m.label}</div>
        <div className="font-semibold text-lg text-foreground tabular-nums">
          {m.value}
        </div>
        {m.sub && <div className="text-muted-foreground text-[11px]">{m.sub}</div>}
        {m.delta && (
          <div
            className={cn(
              "text-xs tabular-nums",
              m.up ? "text-success" : "text-destructive"
            )}
          >
            {m.delta}
          </div>
        )}
      </div>
    ))}
  </div>
);

export const Spark = ({ points, up }: { points: number[]; up: boolean }) => {
  if (points.length < 2) return null;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const w = 100;
  const h = 32;
  const step = w / (points.length - 1);
  const coords = points
    .map((p, i) => `${(i * step).toFixed(2)},${(h - ((p - min) / range) * h).toFixed(2)}`)
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      className={cn("h-16 w-full", up ? "text-success" : "text-destructive")}
      aria-hidden
    >
      <polyline
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        points={coords}
      />
    </svg>
  );
};

export type Series = { points: number[]; times?: string[] };

export function ChartCard({ series, label }: { series: Series; label?: string }) {
  const { points, times } = series;
  const first = points[0];
  const last = points[points.length - 1];
  const up = last >= first;
  const pct = first ? ((last - first) / Math.abs(first)) * 100 : 0;
  return (
    <div className="not-prose space-y-2">
      <div className="flex items-baseline gap-2">
        {label && <span className="text-muted-foreground text-xs">{label}</span>}
        <span className="font-semibold text-2xl text-foreground tabular-nums">
          {fmtNum(last)}
        </span>
        <span
          className={cn(
            "text-xs tabular-nums",
            up ? "text-success" : "text-destructive"
          )}
        >
          {up ? "+" : ""}
          {pct.toFixed(2)}%
        </span>
      </div>
      <Spark points={points} up={up} />
      {times && times.length >= 2 && (
        <div className="flex justify-between text-muted-foreground text-[11px]">
          <span>{times[0]}</span>
          <span>{times[times.length - 1]}</span>
        </div>
      )}
    </div>
  );
}

export function LocationCard({
  title,
  subtitle,
  lat,
  lon,
  extra,
}: {
  title: string;
  subtitle?: string;
  lat: number;
  lon: number;
  extra?: string;
}) {
  return (
    <div className="not-prose flex items-start gap-3">
      <MapPinIcon className="mt-0.5 size-5 shrink-0 text-primary" />
      <div className="min-w-0 space-y-0.5">
        <div className="font-medium text-sm text-foreground">{title}</div>
        {subtitle && (
          <div className="text-muted-foreground text-xs">{subtitle}</div>
        )}
        <div className="text-muted-foreground text-xs tabular-nums">
          {lat.toFixed(4)}, {lon.toFixed(4)}
          {" · "}
          <a
            href={`https://www.google.com/maps?q=${lat},${lon}`}
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:underline"
          >
            View map
          </a>
        </div>
        {extra && <div className="text-muted-foreground text-xs">{extra}</div>}
      </div>
    </div>
  );
}
