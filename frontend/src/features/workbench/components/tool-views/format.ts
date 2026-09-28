/** Formatting + parsing helpers for step-report views. All user-facing
 *  numbers/dates render in en-US via Intl (English UI — DESIGN.md), never
 *  raw JSON field values. Indonesian formatting is reserved for the QRIS
 *  money flow. */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Parse a tool output string that may be JSON; returns the original string
 *  when it isn't JSON. Tolerates JSON cut off mid-stream (the transport
 *  preview caps at 2000 chars) by progressively trimming and re-closing
 *  brackets — the recovered partial object renders, just smaller. */
export function parseMaybeJson(output: string): unknown {
  const t = output.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return output;
  try {
    return JSON.parse(t);
  } catch {
    return repairJson(t);
  }
}

/** Track string state and bracket depth so a cut JSON can be closed. */
function closeJson(s: string): string | null {
  const stack: string[] = [];
  let inStr = false;
  let esc = false;
  for (const ch of s) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let out = s;
  if (inStr) {
    out += '"';
  } else {
    // Drop braces opened but never given content (a trailing `"k": {` would
    // otherwise repair into an empty `{}` element).
    while (out.endsWith("{") || out.endsWith("[")) {
      out = out.slice(0, -1);
      stack.pop();
    }
  }
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i];
  // Drop a dangling comma left right before the re-closed brackets.
  out = out.replace(/,\s*([}\]]+)$/u, "$1");
  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

function repairJson(t: string): unknown {
  // Cut back (bounded sweep) until the remainder closes cleanly. Prefer cuts
  // at value boundaries (after , { } [ ]) so we don't fabricate empty `{}`
  // elements from a dangling `"key": {`; fall back to any position.
  const floor = Math.max(2, t.length - 800);
  const boundary = new Set([",", "{", "}", "[", "]"]);
  for (const pass of [boundary, null]) {
    for (let end = t.length; end >= floor; end--) {
      if (pass && !pass.has(t[end - 1])) continue;
      const v = closeJson(t.slice(0, end));
      if (v !== null) return v;
    }
  }
  return t;
}

const numFmt = (opts?: Intl.NumberFormatOptions) => new Intl.NumberFormat("en-US", opts);

/** "1,234.56" */
export function fmtNumber(n: number, opts?: Intl.NumberFormatOptions): string {
  return numFmt({ maximumFractionDigits: 2, ...opts }).format(n);
}

/** "+2.34%" / "-1.05%" */
export function fmtPct(n: number): string {
  const sign = n > 0 ? "+" : "";
  return `${sign}${numFmt({ minimumFractionDigits: 1, maximumFractionDigits: 2 }).format(n)}%`;
}

/** Human bytes: "1.2 MB". */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${numFmt({ maximumFractionDigits: i === 0 ? 0 : 1 }).format(v)} ${units[i]}`;
}

/** Accepts epoch seconds/millis or an ISO string → "12 Mar 2026, 14.05". */
export function fmtDate(v: unknown): string | null {
  let d: Date | null = null;
  if (typeof v === "number" && Number.isFinite(v)) {
    d = new Date(v > 1e12 ? v : v * 1000);
  } else if (typeof v === "string" && v.trim()) {
    const n = Number(v);
    d = Number.isFinite(n) && v.trim() !== "" ? new Date(n > 1e12 ? n : n * 1000) : new Date(v);
  }
  if (!d || Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(d);
}

/** The one timestamp formatter for English UI surfaces — "Sep 28, 2026,
 *  2:05 PM". Replaces ad-hoc `Date#toLocaleString()`, whose output depends
 *  on the user's machine locale. Invalid dates render as an em dash. */
export function fmtTimestamp(v: Date | number | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime())
    ? "—"
    : new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(d);
}
/** Date-only formatter for English UI — "Sep 28, 2026". Fixed en-US locale. */
export function fmtDateUS(v: Date | number | string): string {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? "—" : new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(d);
}

/** Number formatter for English UI — "1,234". Fixed en-US locale, no decimals. */
export function fmtNumberUS(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}
export function pick<T = unknown>(o: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v as T;
  }
  return undefined;
}

/** Null-safe number coercion ("1,234.5" / 1234.5 → number). */
export function toNum(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
