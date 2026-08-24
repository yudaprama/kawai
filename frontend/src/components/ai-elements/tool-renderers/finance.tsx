import type { ReactNode } from "react";
import { parse, isRecord, num, str, fmtNum, MetricGrid, ChartCard, Footnote, TextCard, cards, type CardItem, type Metric, type Series } from "./shared";

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

// ── builtin.binance agent tools (rig-components/binance) ───────────────────

/** Binance agent balances → { canTrade, balances: [{ asset, free, locked }] }. */
export function renderBinanceBalances(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.balances)) return null;
  const items: Metric[] = d.balances
    .filter(isRecord)
    .slice(0, 9)
    .map((b) => {
      const free = num(b.free) ?? 0;
      const locked = num(b.locked) ?? 0;
      return {
        label: str(b.asset) ?? "—",
        value: fmtNum(free),
        ...(locked > 0 ? { sub: `locked ${fmtNum(locked)}` } : {}),
      };
    });
  return items.length ? <MetricGrid items={items} /> : null;
}

/** Binance agent open orders → { count, orders: [{symbol, side, type, …}] }. */
export function renderBinanceOpenOrders(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.orders)) return null;
  const items: CardItem[] = d.orders
    .filter(isRecord)
    .map((o) => {
      const side = str(o.side)?.toUpperCase();
      const qty = num(o.origQty);
      const filled = num(o.executedQty) ?? 0;
      const price = num(o.price);
      const title =
        [side, str(o.type)?.replace(/_/g, " "), qty !== null ? fmtNum(qty) : null]
          .filter(Boolean)
          .join(" ") || "Order";
      return {
        title,
        subtitle: str(o.symbol),
        meta: [
          ...(price !== null && price > 0 ? [`limit ${fmtNum(price)}`] : []),
          `filled ${fmtNum(filled)}`,
          str(o.status),
        ]
          .filter(Boolean)
      .join(" · "),
    };
  });
  return cards(items);
}

/** Binance agent klines → { candles: [[openTime, o, h, l, c, v], ...] }. */
export function binanceKlineSeries(output: unknown): Series | null {
  const d = parse(output);
  if (!isRecord(d)) return null;
  return klinesSeries(d.candles);
}

/**
 * Binance agent order book → { book: { bestBid, bestAsk, spread, mid },
 * bids/asks: [[price, qty], ...] }.
 */
export function renderBinanceDepth(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !isRecord(d.book)) return null;
  const mid = num(d.book.mid);
  const spread = num(d.book.spread);
  const bid = num(d.book.bestBid);
  const ask = num(d.book.bestAsk);
  if (mid === null || spread === null) return null;
  const symbol = str(d.symbol);
  const items: Metric[] = [
    { label: symbol ? `${symbol} Mid` : "Mid", value: fmtNum(mid) },
    { label: "Spread", value: fmtNum(spread), sub: mid ? `${((spread / mid) * 100).toFixed(3)}%` : undefined },
  ];
  if (bid !== null) items.push({ label: "Best Bid", value: fmtNum(bid) });
  if (ask !== null) items.push({ label: "Best Ask", value: fmtNum(ask) });
  return <MetricGrid items={items} />;
}

/**
 * Binance agent TA suite → flat indicator map ({ ema9, rsi14,
 * macd12269: {macd, signal, histogram}, bb202: {upper, middle, lower}, … })
 * plus { symbol: { symbol, interval, candles }, lastClose, windowChangePct,
 * skipped }.
 */
const TA_KEYS: Array<[key: string, label: string]> = [
  ["ema9", "EMA 9"],
  ["ema21", "EMA 21"],
  ["sma20", "SMA 20"],
  ["wma9", "WMA 9"],
  ["rsi14", "RSI 14"],
  ["atr14", "ATR 14"],
  ["cci20", "CCI 20"],
  ["mfi14", "MFI 14"],
  ["stochK14", "Stoch %K 14"],
  ["sd20", "StdDev 20"],
  ["er14", "Efficiency 14"],
];

export function renderBinanceTa(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const meta = isRecord(d.symbol) ? d.symbol : {};
  const symbol = str(meta.symbol);
  const interval = str(meta.interval);
  const last = num(d.lastClose);
  if (last === null) return null;
  const pct = typeof d.windowChangePct === "string" ? Number(d.windowChangePct) : NaN;
  const candleCount = num(meta.candles);

  const items: Metric[] = [
    {
      label: [symbol, interval, candleCount !== null ? `${candleCount} candles` : null]
        .filter(Boolean)
        .join(" · "),
      value: fmtNum(last),
      delta: Number.isFinite(pct) ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% (window)` : undefined,
      up: Number.isFinite(pct) ? pct >= 0 : undefined,
    },
  ];

  for (const [key, label] of TA_KEYS) {
    const v = num(d[key]);
    if (v !== null) items.push({ label, value: fmtNum(v) });
  }

  // Composite indicators — one cell per family, bands stacked in `sub`.
  const osc = (key: string, label: string) => {
    const m = isRecord(d[key]) ? d[key] : null;
    if (!m) return;
    const hist = num(m.histogram);
    const macdVal = num(m.macd) ?? num(m.ppo);
    const signal = num(m.signal);
    items.push({
      label,
      value: hist !== null ? fmtNum(hist) : macdVal !== null ? fmtNum(macdVal) : "—",
      sub: macdVal !== null && signal !== null ? `${fmtNum(macdVal)} vs ${fmtNum(signal)}` : undefined,
      ...(hist !== null ? { delta: hist >= 0 ? "bullish" : "bearish", up: hist >= 0 } : {}),
    });
  };
  osc("macd12269", "MACD 12/26/9");
  osc("ppo12269", "PPO 12/26/9");

  const bands = (key: string, label: string) => {
    const b = isRecord(d[key]) ? d[key] : null;
    if (!b) return;
    const upper = num(b.upper);
    const middle = num(b.middle) ?? num(b.average);
    const lower = num(b.lower);
    if (middle === null) return;
    items.push({
      label,
      value: fmtNum(middle),
      sub: upper !== null && lower !== null ? `${fmtNum(lower)} — ${fmtNum(upper)}` : undefined,
    });
  };
  bands("bb202", "BB 20×2");
  bands("kc102", "KC 10×2");

  const skipped = Array.isArray(d.skipped)
    ? d.skipped
        .map((s) => (isRecord(s) && typeof s.name === "string" ? s.name : null))
        .filter((s): s is string => s !== null)
    : [];

  return (
    <TextCard>
      <MetricGrid items={items} />
      {skipped.length > 0 && (
        <Footnote>Not enough history for: {skipped.join(", ")}</Footnote>
      )}
    </TextCard>
  );
}
