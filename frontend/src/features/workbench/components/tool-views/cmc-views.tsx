import type { ReactNode } from "react";
import { fmtNumber, fmtPct, isRecord, pick, toNum } from "./format";
import { KeyValueView, Pill, RecordListView, SectionLabel } from "./atoms";
import { SparklineView } from "./finance-views";

// ── CMC envelope ────────────────────────────────────────────────────────────
// CoinMarketCap generated tools return the RAW upstream response body — the
// vendor envelope `{"status":{"error_code":…,"error_message":…},"data":…}`
// passes through verbatim (http-common ToolBase::exec, GET). Views here unwrap
// it; any shape they don't recognize returns null → FallbackView.

type CmcData = { data: Record<string, unknown> | unknown[] };

/** Unwrap the CMC `{status, data}` envelope. Returns null when the payload
 *  isn't a CMC envelope or reports an upstream error. */
function unwrapCmc(p: unknown): CmcData | null {
  if (!isRecord(p) || !isRecord(p.status) || !("data" in p)) return null;
  const code = toNum(p.status.error_code);
  if (code != null && code !== 0) return null;
  if (!isRecord(p.data) && !Array.isArray(p.data)) return null;
  return { data: p.data };
}

/** A coin/pair row with a `quote.USD` sub-record — the common CMC listings /
 *  quotes / dex-pairs shape. */
function quoteOf(r: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(r.quote)) return null;
  const usd = isRecord(r.quote.USD) ? r.quote.USD : isRecord(r.quote.USDT) ? r.quote.USDT : null;
  return usd;
}

function usd(n: number): string {
  return n < 1 ? `$${fmtNumber(n, { maximumFractionDigits: 6 })}` : `$${fmtNumber(n)}`;
}

/** `snake_case` / `camelCase` field → "Snake case" heading. */
function humanKey(k: string): string {
  const words = k
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean);
  return words.map((w) => (w === w.toUpperCase() && w.length <= 4 ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
}

// ── quote rows (listings / quotes / dex pairs / fcas / rwa quotes) ─────────

function CmcQuoteRows({ rows, label }: { rows: Array<Record<string, unknown>>; label: string }) {
  return (
    <div className="space-y-2">
      <SectionLabel>{label}</SectionLabel>
      <ul className="space-y-1.5">
        {rows.slice(0, 12).map((r, i) => {
          const q = quoteOf(r);
          const name = pick<string>(r, "name") ?? pick<string>(r, "symbol") ?? `#${i + 1}`;
          const sym = pick<string>(r, "symbol")?.toUpperCase();
          const price = q ? toNum(pick(q, "price")) : toNum(pick(r, "price", "quote_price"));
          const change = q ? toNum(pick(q, "percent_change_24h", "percentChange24h")) : null;
          const mcap = q ? toNum(pick(q, "market_cap")) : null;
          const rank = toNum(pick(r, "cmc_rank", "rank", "market_cap_rank"));
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: market rows may repeat ids legitimately
            <li key={i} className="bg-card flex items-center gap-3 rounded-lg border px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium">
                  {rank != null && <span className="text-muted-foreground font-mono text-xs">#{rank} </span>}
                  {name} {sym && <span className="text-muted-foreground font-mono text-xs">{sym}</span>}
                </div>
                <div className="text-muted-foreground text-xs">
                  {mcap != null ? `Kap. pasar ${fmtNumber(mcap, { notation: "compact" })}` : ""}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-semibold">{price != null ? usd(price) : "—"}</div>
                {change != null && (
                  <div className={`text-xs ${change >= 0 ? "text-success" : "text-destructive"}`}>
                    {change >= 0 ? "▲" : "▼"} {fmtPct(change)}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {rows.length > 12 && <SectionLabel>…dan {rows.length - 12} baris lainnya</SectionLabel>}
    </div>
  );
}

// ── flat record → key-value (info / detail / metrics / maps) ────────────────

function CmcRecordView({ data }: { data: Record<string, unknown> }) {
  // Historical quotes ride `{quotes: […]}` — render as rows.
  if (Array.isArray(data.quotes)) {
    const rows = data.quotes.filter(isRecord).filter((q) => quoteOf(q) != null);
    if (rows.length > 0) return <CmcQuoteRows rows={rows} label={`${rows.length} titik data historis`} />;
  }
  const entries: Array<[string, ReactNode]> = [];
  for (const [k, v] of Object.entries(data)) {
    if (v == null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      entries.push([humanKey(k), typeof v === "number" ? fmtNumber(v) : String(v)]);
    } else if (isRecord(v)) {
      // `quote.USD` style money objects and flat number maps flatten one level.
      const flat = Object.entries(v).filter(([, x]) => typeof x === "number");
      const nested = Object.entries(v).filter(([, x]) => typeof x === "string" || typeof x === "number");
      if (nested.length > 0 && nested.length === Object.keys(v).length) {
        for (const [sk, sv] of nested) {
          entries.push([
            `${humanKey(k)} ${sk}`,
            typeof sv === "number" ? fmtNumber(sv, { notation: "compact" }) : String(sv),
          ]);
        }
      } else if (flat.length > 0) {
        for (const [sk, sv] of flat) entries.push([`${humanKey(k)} ${sk}`, fmtNumber(sv as number)]);
      } else {
        entries.push([
          humanKey(k),
          <span key={k} className="font-mono text-xs">
            {JSON.stringify(v).slice(0, 200)}
          </span>,
        ]);
      }
    } else if (Array.isArray(v)) {
      entries.push([
        humanKey(k),
        <span key={k} className="font-mono text-xs">
          {v.length} item
        </span>,
      ]);
    }
  }
  if (entries.length === 0) return null;
  return <KeyValueView entries={entries} />;
}

// ── public entry ────────────────────────────────────────────────────────────

/** Smart renderer for every CMC generated tool. Dispatches on the `data`
 *  payload's shape: quote rows for listings, key-value for info/detail,
 *  titled cards for plain record arrays (maps, asset lists, issuers). */
export function CmcView({ parsed }: { parsed: unknown }) {
  const env = unwrapCmc(parsed);
  if (!env) return null;
  const { data } = env;
  if (Array.isArray(data)) {
    const recs = data.filter(isRecord);
    if (recs.length > 0 && recs.every((r) => quoteOf(r) != null)) {
      return <CmcQuoteRows rows={recs} label={`${recs.length} aset — harga pasar`} />;
    }
    if (recs.length > 0 && recs.every((r) => quoteOf(r) == null)) {
      return (
        <RecordListView
          items={recs.map((r, i) => {
            const title =
              pick<string>(r, "name", "title", "symbol", "asset", "issuer_name", "contract_address") ??
              pick<string>(r, "id", "slug") ??
              `Item ${i + 1}`;
            const extras = Object.entries(r)
              .filter(([, v]) => typeof v === "string" || typeof v === "number")
              .slice(0, 3)
              .map(([k, v]) => `${humanKey(k)}: ${v}`)
              .join(" · ");
            return { title, body: extras || undefined };
          })}
        />
      );
    }
    return null; // scalar arrays / mixed → FallbackView bullets
  }
  return <CmcRecordView data={data} />;
}

// ── fear & greed ────────────────────────────────────────────────────────────

const FG_TONE: Record<string, "up" | "down" | "neutral"> = {
  extreme_greed: "up",
  greed: "up",
  neutral: "neutral",
  fear: "down",
  extreme_fear: "down",
};

const FG_LABEL: Record<string, string> = {
  extreme_greed: "Sangat Rakus",
  greed: "Rakus",
  neutral: "Netral",
  fear: "Takut",
  extreme_fear: "Sangat Takut",
};

/** fear_and_greed_latest / _historical → big index value + classification. */
export function CmcFearGreedView({ parsed }: { parsed: unknown }) {
  const env = unwrapCmc(parsed);
  if (!env || !Array.isArray(env.data)) return null;
  const first = env.data.find(isRecord);
  if (!first) return null;
  const value = toNum(pick(first, "value"));
  if (value == null) return null;
  const cls = pick<string>(first, "value_classification") ?? "neutral";
  return (
    <div className="bg-card space-y-1.5 rounded-lg border p-4">
      <SectionLabel>Fear &amp; Greed Index</SectionLabel>
      <div className="flex items-baseline gap-3">
        <span className="text-3xl font-bold">{value}</span>
        <Pill tone={FG_TONE[cls] ?? "neutral"}>{FG_LABEL[cls] ?? cls}</Pill>
      </div>
      {env.data.length > 1 && (
        <p className="text-muted-foreground text-xs">{env.data.length} titik historis dikembalikan</p>
      )}
    </div>
  );
}

// ── OHLCV / kline candles ───────────────────────────────────────────────────

/** kline_candles / kline_points / dex_pairs_ohlcv_* — each candle is a
 *  positional array [open, high, low, close, volume, timestamp, traders]
 *  (v1.gen.rs contract) or an object with `close`. Renders the close series. */
export function CmcOhlcvView({ parsed }: { parsed: unknown }) {
  const env = unwrapCmc(parsed);
  if (!env) return null;
  let rows: unknown[] | null = null;
  if (Array.isArray(env.data)) rows = env.data;
  else if (isRecord(env.data)) {
    for (const key of ["candles", "points", "ohlcv", "quotes", "data"]) {
      if (Array.isArray(env.data[key])) {
        rows = env.data[key] as unknown[];
        break;
      }
    }
  }
  if (!rows || rows.length < 2) return null;
  const closes: number[] = [];
  for (const row of rows) {
    if (Array.isArray(row)) closes.push(toNum(row[3]) ?? 0);
    else if (isRecord(row)) {
      const c = toNum(pick(row, "close", "quote_price", "price"));
      if (c != null) closes.push(c);
    }
  }
  if (closes.length < 2) return null;
  return <SparklineView closes={closes} label={`${closes.length} candle`} />;
}
