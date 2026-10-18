import type { ReactNode } from "react";

import { Icon } from "@/components/shared/icon";

import { Footnote, TextCard, fmtNum, isRecord, num, parse, str } from "./shared";

// ── desk_data ───────────────────────────────────────────────────────────────

/**
 * desk_data →
 * { kind: "desk_data", ticker, domain, tradeDate, analysts: string[],
 *   market | social | news | fundamentals:
 *     { sources: [{label, body}], failures: [{label, error}], errorsTotal,
 *       skipped },
 *   ledger: {...} | null, sourcesTotal, errorsTotal, partial }.
 *
 * Phase 0 of the desk pipeline: its PRODUCT is the fetched research corpus —
 * the card reports per-group coverage and the failure rows, never the source
 * bodies (the analyst reports below consume those). A skipped group is the
 * run's own selection; a failed source is a row that must stay visible —
 * "did the scan come up empty, or did the fetch die?" is the first question
 * a reader asks.
 */

const GROUPS: { key: string; label: string }[] = [
  { key: "market", label: "Market" },
  { key: "social", label: "Social" },
  { key: "news", label: "News" },
  { key: "fundamentals", label: "Fundamentals" },
];

interface GroupCounts {
  sources: number;
  failures: number;
  skipped: boolean;
  failureRows: { label: string; error: string }[];
}

function groupCounts(d: Record<string, unknown>, key: string): GroupCounts {
  const g = d[key];
  if (!isRecord(g)) return { sources: 0, failures: 0, skipped: false, failureRows: [] };
  const sources = Array.isArray(g.sources) ? g.sources.length : 0;
  const rows = Array.isArray(g.failures) ? g.failures : [];
  return {
    sources,
    failures: num(g.errorsTotal) ?? rows.length,
    skipped: g.skipped === true,
    failureRows: rows.filter(isRecord).map((r) => ({
      label: str(r.label) ?? "source",
      error: str(r.error) ?? "failed",
    })),
  };
}

export function renderDeskData(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || d.kind !== "desk_data") return null;
  const ticker = str(d.ticker) ?? "";
  const domain = str(d.domain) ?? "";
  const partial = d.partial === true;
  const sourcesTotal = num(d.sourcesTotal) ?? 0;
  const groups = GROUPS.map((g) => ({ ...g, ...groupCounts(d, g.key) }));
  const failures = groups.flatMap((g) => g.failureRows.map((r) => ({ ...r, group: g.label })));
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="database" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Research data
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">
          {ticker} · {domain}
        </span>
        {partial && (
          <span className="border-warning/30 bg-warning/10 text-warning rounded-sm border px-1 py-px font-mono text-[10px] uppercase">
            partial
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {groups.map((g) => (
          <span key={g.key} className="font-mono text-[11px]">
            {g.skipped ? (
              <span className="text-muted-foreground">
                {g.label}: <span data-testid="desk-skipped">skipped</span>
              </span>
            ) : (
              <span className={g.failures > 0 ? "text-warning" : "text-foreground"}>
                {g.label}: {fmtNum(g.sources)} source{g.sources === 1 ? "" : "s"}
                {g.failures > 0 ? ` · ${fmtNum(g.failures)} failed` : ""}
              </span>
            )}
          </span>
        ))}
      </div>
      <p className="text-muted-foreground mt-2 font-mono text-[11px]">
        Fetched {fmtNum(sourcesTotal)} source{sourcesTotal === 1 ? "" : "s"} once — the analyst
        reports below bind this data (no refetch)
        {d.ledger !== null && d.ledger !== undefined ? " + your own realized record" : ""}.
      </p>
      {failures.length > 0 && (
        <Footnote>
          {failures.map((f) => (
            <div key={`${f.group}-${f.label}`}>
              {f.label} — {f.error}
            </div>
          ))}
        </Footnote>
      )}
    </TextCard>
  );
}
