import type { ReactNode } from "react";
import { parse, isRecord, num, str, fmtNum, MetricGrid, ChartCard, type Metric, type Series } from "./shared";

/** frankfurter → { amount, base, rates: { SYMBOL: rate } } */
export function renderCurrency(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !isRecord(d.rates)) return null;
  const base = typeof d.base === "string" ? d.base : "";
  const items = Object.entries(d.rates)
    .filter(([, v]) => typeof v === "number")
    .map(([sym, v]) => ({
      label: sym,
      value: fmtNum(v as number),
      sub: base ? `per 1 ${base}` : undefined,
    }));
  return items.length ? <MetricGrid items={items} /> : null;
}

/** coingecko simple/price → { bitcoin: { usd: 65000 }, ... } */
export function renderCryptoPrice(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const items: Metric[] = [];
  for (const [coin, prices] of Object.entries(d)) {
    if (!isRecord(prices)) continue;
    const cur = Object.entries(prices).find(([, v]) => typeof v === "number");
    if (!cur) continue;
    items.push({
      label: coin.replace(/-/g, " ").toUpperCase(),
      value: fmtNum(cur[1] as number),
      sub: cur[0].toUpperCase(),
    });
  }
  return items.length ? <MetricGrid items={items} /> : null;
}

/** Alpha Vantage GLOBAL_QUOTE → { "Global Quote": { "05. price", "10. change percent" } } */
export function renderStockQuote(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const q = isRecord(d["Global Quote"]) ? d["Global Quote"] : null;
  if (!q) return null;
  const symbol = typeof q["01. symbol"] === "string" ? q["01. symbol"] : "";
  const price = typeof q["05. price"] === "string" ? q["05. price"] : null;
  if (!price) return null;
  const pct =
    typeof q["10. change percent"] === "string"
      ? q["10. change percent"]
      : null;
  const change = typeof q["09. change"] === "string" ? q["09. change"] : null;
  const up = change ? Number(change) >= 0 : undefined;
  return (
    <MetricGrid
      items={[
        {
          label: symbol || "Price",
          value: fmtNum(Number(price)),
          delta:
            change && pct
              ? `${up ? "+" : ""}${change} (${pct})`
              : undefined,
          up,
        },
      ]}
    />
  );
}

/** Binance 24hr ticker → { lastPrice, priceChange, priceChangePercent, highPrice, lowPrice } */
export function renderTicker24(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const last = num(d.lastPrice);
  if (last === null) return null;
  const change = num(d.priceChange);
  const pct = num(d.priceChangePercent);
  const high = num(d.highPrice);
  const low = num(d.lowPrice);
  const up = change !== null ? change >= 0 : undefined;
  const items: Metric[] = [
    {
      label: str(d.symbol) ?? "Last",
      value: fmtNum(last),
      delta:
        change !== null && pct !== null
          ? `${up ? "+" : ""}${fmtNum(change)} (${pct.toFixed(2)}%)`
          : undefined,
      up,
    },
  ];
  if (high !== null) items.push({ label: "24h High", value: fmtNum(high) });
  if (low !== null) items.push({ label: "24h Low", value: fmtNum(low) });
  return <MetricGrid items={items} />;
}

/** Twelve Data → { values: [{ datetime, <field> }] } (descending → reversed). */
export function twelveSeries(output: unknown, field: string): Series | null {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.values)) return null;
  const rows = [...d.values].reverse();
  const points: number[] = [];
  const times: string[] = [];
  for (const r of rows) {
    if (!isRecord(r)) continue;
    const p = num(r[field]);
    if (p === null) continue;
    points.push(p);
    if (typeof r.datetime === "string") times.push(r.datetime);
  }
  return points.length >= 2 ? { points, times } : null;
}

/** Binance klines → [[openTime, open, high, low, close, ...], ...] (ascending). */
export function klinesSeries(output: unknown): Series | null {
  const d = parse(output);
  if (!Array.isArray(d)) return null;
  const points: number[] = [];
  for (const row of d) {
    if (!Array.isArray(row)) continue;
    const c = num(row[4]);
    if (c !== null) points.push(c);
  }
  return points.length >= 2 ? { points } : null;
}

/** Tiingo FX → [{ date, close }] (ascending). */
export function tiingoSeries(output: unknown): Series | null {
  const d = parse(output);
  if (!Array.isArray(d)) return null;
  const points: number[] = [];
  const times: string[] = [];
  for (const r of d) {
    if (!isRecord(r)) continue;
    const c = num(r.close);
    if (c === null) continue;
    points.push(c);
    if (typeof r.date === "string") times.push(r.date.slice(0, 10));
  }
  return points.length >= 2 ? { points, times } : null;
}

export function chart(series: Series | null, label?: string): ReactNode {
  return series ? <ChartCard series={series} label={label} /> : null;
}
