import type { ReactNode } from "react";

// ── Shared atoms ────────────────────────────────────────────────────────────

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>;
}

/** Two-column "label → value" table for flat facts. */
export function KeyValueView({ entries }: { entries: Array<[string, ReactNode]> }) {
  const rows = entries.filter(([, v]) => v != null && v !== "");
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div className="contents" key={k}>
          <dt className="text-muted-foreground py-0.5">{k}</dt>
          <dd className="text-foreground break-words py-0.5">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export const Pill = ({ children, tone = "neutral" }: { children: ReactNode; tone?: "up" | "down" | "neutral" }) => (
  <span
    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
      tone === "up"
        ? "bg-success/15 text-success"
        : tone === "down"
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground"
    }`}
  >
    {children}
  </span>
);

// ── record-list (memories, generic titled entities) ─────────────────────────

export interface RecordItem {
  title: string;
  badge?: string;
  meta?: string;
  body?: string;
}

/** Titled cards with an optional body — memory items, search hits, posts. */
export function RecordListView({ items }: { items: RecordItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{items.length} hasil ditemukan</SectionLabel>
      <ul className="space-y-2">
        {items.slice(0, 20).map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
          <li className="bg-card rounded-lg border p-3" key={`${it.title}:${i}`}>
            <div className="flex items-center gap-2">
              {it.badge && <Pill>{it.badge}</Pill>}
              <span className="text-foreground min-w-0 truncate text-sm font-medium" title={it.title}>
                {it.title}
              </span>
              {it.meta && (
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px]">{it.meta}</span>
              )}
            </div>
            {it.body && <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{it.body}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
