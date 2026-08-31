/**
 * Pure helpers for the analytics agent's frontend surfaces: chart detection
 * over `data_query` rows, CSV serialization for exports, and display
 * hygiene for SQL profile sources (credential masking, remote detection).
 */

// ── data_query chart detection ────────────────────────────────────────────────

export interface ChartSpec {
  /** Column name of the categorical axis. */
  dim: string;
  /** Column name of the numeric series. */
  measure: string;
  labels: string[];
  values: number[];
}

const CHART_MAX_ROWS = 60;
const DIM_RATIO = 0.8;
const MEASURE_RATIO = 0.8;

function isNumericLikeString(s: string): boolean {
  return s.trim() !== "" && Number.isFinite(Number(s));
}

function isDimValue(v: unknown): boolean {
  return typeof v === "string" && v !== "" && !isNumericLikeString(v);
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * Detect whether a `data_query` result is chartable as one categorical axis
 * + one numeric series: exactly 2 columns, the first mostly non-numeric
 * strings (dates like "2026-01" count as categorical — `Number("2026-01")`
 * is NaN), the second mostly finite numbers. Returns `null` otherwise.
 */
export function detectQueryChart(rows: Record<string, unknown>[]): ChartSpec | null {
  if (rows.length < 2 || rows.length > CHART_MAX_ROWS) return null;
  const cols = Object.keys(rows[0] ?? {});
  if (cols.length !== 2) return null;
  const [dim, measure] = cols;
  const dimOk = rows.filter((r) => isDimValue(r[dim])).length / rows.length;
  if (dimOk < DIM_RATIO) return null;
  const data = rows.filter((r) => isFiniteNumber(r[measure]));
  if (data.length < 2 || data.length / rows.length < MEASURE_RATIO) return null;
  return {
    dim,
    measure,
    labels: data.map((r) => String(r[dim])),
    values: data.map((r) => r[measure] as number),
  };
}

// ── CSV export ────────────────────────────────────────────────────────────────

function csvCell(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v) ?? "";
}

function csvEscape(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Serialize query rows to CSV. Headers come from the first row's keys. */
export function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0] ?? {});
  const lines = [cols.map((c) => csvEscape(c)).join(",")];
  for (const row of rows) {
    lines.push(cols.map((c) => csvEscape(csvCell(row[c]))).join(","));
  }
  return lines.join("\n");
}

// ── SQL profile display ──────────────────────────────────────────────────────

const REMOTE_PREFIXES = ["postgres://", "postgresql://", "mysql://", "mariadb://"];

/** Mirror of the backend's `looks_remote` — `postgres://`/`mysql://` URLs. */
export function isRemoteSource(source: string): boolean {
  const t = source.trim().toLowerCase();
  return REMOTE_PREFIXES.some((p) => t.startsWith(p));
}

/**
 * Redact the password of inline-credential URLs for display:
 * `postgres://user:secret@host/db` → `postgres://user:***@host/db`.
 * URLs without a password pass through unchanged.
 */
export function maskSource(source: string): string {
  return source.replace(/(:\/\/[^:/@?\s]+:)[^@?\s]+@/g, "$1***@");
}
