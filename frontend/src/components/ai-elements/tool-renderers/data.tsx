import type { ReactNode } from "react";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { type ChartSpec, detectQueryChart, rowsToCsv } from "@/features/analytics/lib/analytics";
import { triggerDownload } from "@/lib/download";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { formatBytes } from "@/lib/utils";
import { fmtNum, Footnote, isRecord, MetricGrid, parse, str, type Metric } from "./shared";

/**
 * Renderers for the Analytics agent's `data_*` tools. Every renderer receives
 * the structured `data` payload from the ToolResult event (already-parsed
 * JSON) — or a raw string in tests — and returns `null` when the shape
 * doesn't match, falling back to the generic JSON output.
 */

const CELL_MAX = 60;
const TABLE_ROW_CAP = 50;
const CHART_MAX_BARS = 30;

const compactFmt = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function cellText(v: unknown): string {
  const s = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
  return s.length > CELL_MAX ? `${s.slice(0, CELL_MAX - 1)}…` : s;
}

function cellNum(v: unknown): string {
  return typeof v === "number" ? fmtNum(v) : cellText(v);
}

/** Shared table for query rows: header from the first row's keys. */
function RowsTable({ rows }: { rows: Record<string, unknown>[] }) {
  if (rows.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">0 rows — no data matched.</p>
    );
  }
  const cols = Object.keys(rows[0] ?? {});
  return (
    <div className="not-prose overflow-x-auto rounded-md border">
      <table className="w-full text-xs">
        <thead>
          <tr className="bg-muted/60 border-b text-left">
            {cols.map((c) => (
              <th key={c} className="px-2 py-1.5 font-medium whitespace-nowrap">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b last:border-b-0">
              {cols.map((c) => (
                <td key={c} className="px-2 py-1 whitespace-nowrap tabular-nums">
                  {cellNum(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Compact bar chart for one categorical axis + one numeric series. */
function QueryBarChart({ spec }: { spec: ChartSpec }) {
  const labels = spec.labels.slice(0, CHART_MAX_BARS);
  const values = spec.values.slice(0, CHART_MAX_BARS);
  const max = Math.max(...values);
  const baseline = Math.min(0, ...values);
  const span = max - baseline || 1;
  const showValues = values.length <= 12;
  const H = 96;
  return (
    <div className="not-prose overflow-x-auto">
      <div className="min-w-max">
        <div className="flex items-end gap-1" style={{ height: H + (showValues ? 14 : 0) }}>
          {values.map((v, i) => (
            <div
              className="flex w-8 shrink-0 flex-col justify-end"
              key={i}
              title={`${labels[i]}: ${fmtNum(v)}`}
            >
              {showValues && (
                <span className="text-muted-foreground mb-0.5 text-center text-[10px] tabular-nums">
                  {compactFmt.format(v)}
                </span>
              )}
              <div
                className={`${v === max ? "bg-primary" : "bg-primary/50"} rounded-t-sm`}
                style={{ height: Math.max(((v - baseline) / span) * H, 2) }}
              />
            </div>
          ))}
        </div>
        <div className="mt-1 flex gap-1">
          {labels.map((l, i) => (
            <span className="text-muted-foreground w-8 shrink-0 truncate text-center text-[10px]" key={i}>
              {l}
            </span>
          ))}
        </div>
        {spec.labels.length > CHART_MAX_BARS && (
          <p className="text-muted-foreground mt-1 text-[10px]">
            showing first {CHART_MAX_BARS} of {spec.labels.length}
          </p>
        )}
      </div>
    </div>
  );
}

function DataViewToggle({ view, onChange }: { view: "chart" | "table"; onChange: (v: "chart" | "table") => void }) {
  return (
    <div className="border-muted-foreground/30 inline-flex rounded-md border p-0.5">
      {(["chart", "table"] as const).map((v) => (
        <button
          className={`rounded px-1.5 py-0.5 text-[11px] ${
            view === v ? "bg-muted text-foreground" : "text-muted-foreground"
          }`}
          key={v}
          onClick={() => onChange(v)}
          type="button"
        >
          {v === "chart" ? "Chart" : "Table"}
        </button>
      ))}
    </div>
  );
}

/** data_query → { rows: [...], _meta: { rows_returned, limit, possibly_more_rows, mode } } */
function DataQueryCard({ rows, meta }: { rows: Record<string, unknown>[]; meta: Record<string, unknown> }) {
  const spec = detectQueryChart(rows);
  const [view, setView] = useState<"chart" | "table">(spec ? "chart" : "table");
  const [showAll, setShowAll] = useState(false);
  const more = meta.possibly_more_rows === true;
  const metaBits: string[] = [];
  if (typeof meta.rows_returned === "number") metaBits.push(`${fmtNum(meta.rows_returned)} rows`);
  if (typeof meta.limit === "number") metaBits.push(`limit ${fmtNum(meta.limit)}`);
  if (meta.mode === "aggregate") metaBits.push("aggregated");
  const capped = rows.length > TABLE_ROW_CAP;
  const truncated = capped && !showAll;
  if (truncated) metaBits.push(`showing first ${TABLE_ROW_CAP}`);
  const visible = truncated ? rows.slice(0, TABLE_ROW_CAP) : rows;
  const download = () => triggerDownload("data-query.csv", rowsToCsv(rows), "text/csv");
  return (
    <div className="not-prose space-y-1.5">
      <div className="flex min-h-6 items-center justify-between gap-2">
        {spec ? <DataViewToggle view={view} onChange={setView} /> : <span />}
        <button
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[11px]"
          onClick={download}
          type="button"
        >
          <DownloadIcon className="size-3" />
          CSV
        </button>
      </div>
      {spec && view === "chart" ? (
        <QueryBarChart spec={spec} />
      ) : (
        <>
          <RowsTable rows={visible} />
          {capped && (
            <button
              className="text-muted-foreground hover:text-foreground text-xs underline"
              onClick={() => setShowAll((v) => !v)}
              type="button"
            >
              {showAll ? "Show fewer rows" : `Show all ${rows.length} rows`}
            </button>
          )}
        </>
      )}
      {metaBits.length > 0 && (
        <Footnote>
          {metaBits.join(" · ")}
          {more ? " — possibly more rows beyond the limit" : ""}
        </Footnote>
      )}
    </div>
  );
}

export function renderDataQuery(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.rows)) return null;
  const rows = d.rows.filter(isRecord);
  const m = isRecord(d._meta) ? d._meta : {};
  return <DataQueryCard meta={m} rows={rows} />;
}

/** data_schema → SchemaInfo (camelCase): columns with dtypes + samples. */
export function renderDataSchema(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.columns)) return null;
  const rows = d.columns.filter(isRecord);
  if (rows.length === 0) return null;
  const meta: string[] = [];
  const format = str(d.format);
  if (format) meta.push(format);
  if (typeof d.rows === "number") meta.push(`${fmtNum(d.rows)} rows`);
  if (typeof d.bytes === "number") meta.push(formatBytes(d.bytes));
  const sheets = Array.isArray(d.sheets) ? d.sheets.filter((s): s is string => typeof s === "string") : [];
  return (
    <div className="not-prose space-y-1.5">
      {meta.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {meta.join(" · ")}
          {sheets.length > 0 ? ` · sheets: ${sheets.join(", ")}` : ""}
          {str(d.activeSheet) ? ` · active: ${str(d.activeSheet)}` : ""}
        </p>
      )}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/60 border-b text-left">
              <th className="px-2 py-1.5 font-medium">column</th>
              <th className="px-2 py-1.5 font-medium">type</th>
              <th className="px-2 py-1.5 font-medium">sample values</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c, i) => {
              const samples = Array.isArray(c.samples) ? c.samples.map(cellText) : [];
              return (
                <tr key={i} className="border-b last:border-b-0">
                  <td className="px-2 py-1 font-mono">{str(c.name) ?? ""}</td>
                  <td className="text-muted-foreground px-2 py-1 whitespace-nowrap">
                    {str(c.dtype) ?? ""}
                  </td>
                  <td className="text-muted-foreground/80 px-2 py-1 truncate max-w-64">
                    {samples.join(" · ")}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** data_ta → { indicators: { alias: value }, _meta: { rowsUsed, sortedBy?, skipped? } } */
export function renderDataTa(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !isRecord(d.indicators)) return null;
  const items: Metric[] = [];
  for (const [alias, v] of Object.entries(d.indicators)) {
    if (typeof v !== "number") continue;
    items.push({ label: alias, value: fmtNum(v) });
  }
  if (items.length === 0) return null;
  const m = isRecord(d._meta) ? d._meta : {};
  const bits: string[] = [];
  if (typeof m.rowsUsed === "number") bits.push(`${fmtNum(m.rowsUsed)} rows folded`);
  if (str(m.sortedBy)) bits.push(`sorted by ${str(m.sortedBy)}`);
  const skipped = Array.isArray(m.skipped)
    ? m.skipped.filter(isRecord).map((s) => str(s.alias)).filter((a): a is string => !!a)
    : [];
  if (skipped.length) bits.push(`skipped: ${skipped.join(", ")} (insufficient history)`);
  return (
    <div className="not-prose space-y-1.5">
      <MetricGrid items={items} />
      {bits.length > 0 && <Footnote>{bits.join(" · ")}</Footnote>}
    </div>
  );
}

/** data_tables → { profile, tables: [{ name, kind }] } */
export function renderDataTables(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.tables)) return null;
  const tables = d.tables.filter(isRecord);
  if (tables.length === 0) return null;
  const profile = str(d.profile);
  return (
    <div className="not-prose space-y-1.5">
      {profile && <p className="text-muted-foreground text-xs">profile {profile}</p>}
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-muted/60 border-b text-left">
              <th className="px-2 py-1.5 font-medium">name</th>
              <th className="px-2 py-1.5 font-medium">kind</th>
            </tr>
          </thead>
          <tbody>
            {tables.map((t, i) => (
              <tr key={i} className="border-b last:border-b-0">
                <td className="px-2 py-1 font-mono">{str(t.name) ?? ""}</td>
                <td className="text-muted-foreground px-2 py-1">{str(t.kind) ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** data_chart → { fileId, fileName, mark, x, rows, note } */
export function renderDataChart(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !str(d.fileId)) return null;
  const fileId = str(d.fileId) ?? "";
  const fileName = str(d.fileName);
  const mark = str(d.mark) ?? "chart";
  const rows = typeof d.rows === "number" ? fmtNum(d.rows) : null;
  const items: Metric[] = [
    {
      label: fileName ?? `${mark} chart`,
      value: `${mark} chart`,
      sub: rows ? `${rows} rows plotted` : undefined,
    },
  ];
  return (
    <div className="not-prose space-y-1.5">
      <MetricGrid items={items} />
      {fileId && (
        <button
          className="text-primary hover:underline text-xs"
          onClick={() => emitOpenPreview(fileId, fileName ?? "chart")}
          type="button"
        >
          Open chart
        </button>
      )}
    </div>
  );
}

/** data_import → { fileId, fileName, source: { profile, table }, rows, truncated, maxRows } */
export function renderDataImport(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !str(d.fileId)) return null;
  const src = isRecord(d.source) ? d.source : {};
  const truncated = d.truncated === true;
  const fileId = str(d.fileId) ?? "";
  const fileName = str(d.fileName);
  const items: Metric[] = [
    {
      label: fileName ?? "snapshot",
      value: typeof d.rows === "number" ? `${fmtNum(d.rows)} rows` : "imported",
      sub: [str(src.profile), str(src.table)].filter(Boolean).join(" · ") || undefined,
    },
  ];
  return (
    <div className="not-prose space-y-1.5">
      <MetricGrid items={items} />
      {fileId && (
        <button
          className="text-primary hover:underline text-xs"
          onClick={() => emitOpenPreview(fileId, fileName ?? "snapshot")}
          type="button"
        >
          Preview snapshot
        </button>
      )}
      <Footnote>
        {truncated
          ? `Truncated at the ${typeof d.maxRows === "number" ? fmtNum(d.maxRows) : "?"}-row cap — analysis covers the first rows only.`
          : "Complete snapshot — ready for data_schema / data_query."}
      </Footnote>
    </div>
  );
}
