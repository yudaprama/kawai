import type { ReactNode } from "react";
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
          {rows.slice(0, TABLE_ROW_CAP).map((r, i) => (
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

/** data_query → { rows: [...], _meta: { rows_returned, limit, possibly_more_rows, mode } } */
export function renderDataQuery(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.rows)) return null;
  const rows = d.rows.filter(isRecord);
  const m = isRecord(d._meta) ? d._meta : {};
  const more = m.possibly_more_rows === true;
  const metaBits: string[] = [];
  if (typeof m.rows_returned === "number") metaBits.push(`${fmtNum(m.rows_returned)} rows`);
  if (typeof m.limit === "number") metaBits.push(`limit ${fmtNum(m.limit)}`);
  if (m.mode === "aggregate") metaBits.push("aggregated");
  if (rows.length > TABLE_ROW_CAP) metaBits.push(`showing first ${TABLE_ROW_CAP}`);
  return (
    <div className="not-prose space-y-1.5">
      <RowsTable rows={rows} />
      {metaBits.length > 0 && (
        <Footnote>
          {metaBits.join(" · ")}
          {more ? " — possibly more rows beyond the limit" : ""}
        </Footnote>
      )}
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

/** data_import → { fileId, fileName, source: { profile, table }, rows, truncated, maxRows } */
export function renderDataImport(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !str(d.fileId)) return null;
  const src = isRecord(d.source) ? d.source : {};
  const truncated = d.truncated === true;
  const items: Metric[] = [
    {
      label: str(d.fileName) ?? "snapshot",
      value: typeof d.rows === "number" ? `${fmtNum(d.rows)} rows` : "imported",
      sub: [str(src.profile), str(src.table)].filter(Boolean).join(" · ") || undefined,
    },
  ];
  return (
    <div className="not-prose space-y-1.5">
      <MetricGrid items={items} />
      <Footnote>
        {truncated
          ? `Truncated at the ${typeof d.maxRows === "number" ? fmtNum(d.maxRows) : "?"}-row cap — analysis covers the first rows only.`
          : "Complete snapshot — ready for data_schema / data_query."}
      </Footnote>
    </div>
  );
}
