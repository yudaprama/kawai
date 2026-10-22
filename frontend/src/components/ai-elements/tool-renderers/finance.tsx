import { useState, type ReactNode } from "react";
import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";
import { parse, isRecord, num, str, fmtNum, fmtPrice, fmtMoney, fmtPct, fmtRR, fmtSigned, placedRR, TpLadder, MetricGrid, ChartCard, Footnote, TextCard, cards, type CardItem, type Metric, type Series } from "./shared";

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

// ── builtin.binance agent tools (crates/toolsets/binance) ───────────────────

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


/**
 * Shared presentational core for every venue's futures-positions card.
 *
 * Binance and MEXC mirror the same open positions into the same local tables,
 * so they show the same things; the only real differences are venue-specific
 * (Binance's COIN-M settlement rollup, MEXC's venue strip and its explicit
 * "nothing mirrored" note). Those differences live in the caller's slots, not
 * in a second copy of this markup.
 */
function futuresPositionsCard(opts: {
  positions: CardItem[];
  orders: CardItem[];
  /** Rendered when the venue has neither positions nor orders. */
  empty: ReactNode;
  /** Venue strip / identity line above the rows (Binance: none). */
  header?: ReactNode;
  /** Label over the order list; unset means the list is not headed. */
  ordersTitle?: string;
  /** Replaces an empty order list — MEXC must say so instead of showing nothing. */
  noOrders?: ReactNode;
  /** Aggregate lines under the rows (total PnL, per-asset rollup). */
  footer?: ReactNode;
}): ReactNode {
  const { positions, orders, empty, header, ordersTitle, noOrders, footer } = opts;
  if (!positions.length && !orders.length) return <TextCard>{empty}</TextCard>;
  return (
    <>
      {header}
      {cards(positions)}
      {ordersTitle ? (
        <>
          <div className="not-prose pt-2 text-muted-foreground text-xs font-medium uppercase">
            {ordersTitle}
          </div>
          {orders.length ? cards(orders) : noOrders}
        </>
      ) : orders.length ? (
        cards(orders)
      ) : null}
      {footer}
    </>
  );
}

/** One open position → a card row. `tagOf` is the venue's settlement label. */
function positionCards(rows: unknown[], tagOf?: (p: Record<string, unknown>) => string | undefined): CardItem[] {
  return rows.filter(isRecord).map((p) => {
    const side = str(p.positionSide)?.toUpperCase();
    const amt = num(p.positionAmt);
    const entry = num(p.entryPrice);
    const mark = num(p.markPrice);
    const pnl = num(p.unRealizedProfit);
    const liq = num(p.liquidationPrice);
    const notional = num(p.notional);
    const tag = tagOf?.(p);
    return {
      title: [str(p.symbol), side].filter(Boolean).join(" ") || "Position",
      subtitle: amt !== null ? `${fmtNum(amt)} @ ${entry !== null ? fmtNum(entry) : "—"}` : undefined,
      meta: [
        ...(tag ? [tag] : []),
        ...(mark !== null ? [`mark ${fmtNum(mark)}`] : []),
        ...(pnl !== null ? [`PnL ${fmtNum(pnl)}`] : []),
        ...(liq !== null && liq > 0 ? [`liq ${fmtNum(liq)}`] : []),
        ...(notional !== null && notional !== 0 ? [`${fmtNum(notional)} notional`] : []),
      ].join(" · "),
    };
  });
}

/** One resting order → a card row. Order type is spelled `type` on Binance
 * and `orderType` on MEXC; both mean the same thing here. */
function orderCards(rows: unknown[], tagOf?: (o: Record<string, unknown>) => string | undefined): CardItem[] {
  return rows.filter(isRecord).map((o) => {
    const intent = str(o.intent)?.toUpperCase();
    const kind = (str(o.orderType) ?? str(o.type))?.replace(/_/g, " ");
    const qty = num(o.origQty);
    const price = num(o.price);
    const stop = num(o.stopPrice);
    // Stop/TP orders carry their level in stopPrice; a plain limit uses price.
    const level = stop !== null && stop > 0 ? stop : price;
    const tag = tagOf?.(o);
    return {
      title: [str(o.symbol), intent ?? kind].filter(Boolean).join(" ") || "Order",
      subtitle:
        qty !== null ? `${fmtNum(qty)} @ ${level !== null && level > 0 ? fmtNum(level) : "market"}` : undefined,
      meta: [
        ...(tag ? [tag] : []),
        ...(kind !== undefined ? [kind] : []),
        str(o.side)?.toUpperCase(),
        ...(o.reduceOnly === true ? ["reduce-only"] : []),
        ...(o.closePosition === true ? ["close-position"] : []),
      ]
        .filter(Boolean)
        .join(" · "),
    };
  });
}

/**
 * Binance agent futures positions + open orders →
 * { synced, totalUnrealizedPnl, positions: [...],
 *   openOrders: [{ orderId, symbol, side, type, intent, origQty, price,
 *                 stopPrice, reduceOnly, ... }] }.
 *
 * Two lists: positions (signed size + side carry the direction, so a short
 * reads as SHORT with a negative amount), then the resting orders grouped by
 * the server-side `intent` — stop-losses and take-profits are the ones the
 * user is actually looking for, so they lead.
 *
 * The rows come from the shared futures-positions core; only the venue
 * specifics (the COIN-M settlement rollup, which is Binance-only) stay here.
 */
export function renderBinanceFuturesPositions(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.positions)) return null;
  const positions = positionCards(d.positions, (p) => {
    const market = str(p.margin)?.toUpperCase();
    return market === "COINM" ? "COIN-M" : market === "USDM" ? undefined : market;
  });
  const orders = orderCards(Array.isArray(d.openOrders) ? d.openOrders : [], (o) =>
    str(o.margin)?.toUpperCase() === "COINM" ? "COIN-M" : undefined,
  );
  const total = num(d.totalUnrealizedPnl);
  // COIN-M PnL is denominated in the settlement coin, so it is NEVER summed
  // into the USDT total — each asset renders as its own line.
  const coinm = isRecord(d.coinmUnrealizedPnlByAsset) ? d.coinmUnrealizedPnlByAsset : {};
  const coinmLines = Object.entries(coinm).filter(
    ([, v]) => typeof v === "number" && v !== 0,
  );
  return futuresPositionsCard({
    positions,
    orders,
    empty: <Footnote>No open Binance futures positions or orders.</Footnote>,
    ordersTitle: "Open orders",
    footer: (
      <>
        {total !== null ? <Footnote>Total unrealized PnL (USDⓈ-M) {fmtNum(total)}</Footnote> : null}
        {coinmLines.map(([asset, v]) => (
          <Footnote key={asset}>
            COIN-M unrealized PnL ({asset}) {fmtNum(v as number)}
          </Footnote>
        ))}
      </>
    ),
  });
}

/**
 * MEXC agent futures positions →
 * { kind: "futures_positions", venue, market, synced, totalUnrealizedPnl,
 *   positions: [...], orders: [...] }.
 *
 * MEXC has no COIN-M, so there is no per-settlement-asset rollup, and it
 * mirrors positions only: `orders` comes back empty and the card SAYS that
 * rather than rendering an empty table that reads like a sync gap.
 */
export function renderMexcFuturesPositions(output: unknown): ReactNode {
  const d = parse(output);
  // Flat payloads carry a `kind` discriminator; anything else belongs to the
  // raw-JSON card, not here.
  if (!isRecord(d) || d.kind !== "futures_positions" || !Array.isArray(d.positions)) return null;
  const positions = positionCards(d.positions);
  const orders = orderCards(Array.isArray(d.orders) ? d.orders : []);
  const total = num(d.totalUnrealizedPnl);
  const venue = str(d.venue)?.toUpperCase();
  const market = str(d.market)?.toUpperCase();
  const synced = num(d.synced);
  const items: Metric[] = [
    { label: venue ? `${venue} positions` : "Positions", value: synced !== null ? fmtNum(synced) : "—" },
    ...(market ? [{ label: "Market", value: market }] : []),
    ...(total !== null ? [{ label: "Unrealized PnL", value: fmtNum(total), delta: fmtNum(total) }] : []),
  ];
  return futuresPositionsCard({
    positions,
    orders,
    empty: <Footnote>No open MEXC futures positions.</Footnote>,
    header: <MetricGrid items={items} />,
    ordersTitle: "Resting orders",
    noOrders: <Footnote>No resting orders mirrored.</Footnote>,
  });
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

  // Fallback: everything the curated lists don't cover — preset keys outside
  // TA_KEYS (obv, roc9, the newer indicator families) plus custom-window
  // keys and aliases from {kind, period, …} indicator specs.
  const covered = new Set([
    ...TA_KEYS.map(([key]) => key),
    "macd12269",
    "ppo12269",
    "bb202",
    "kc102",
    "symbol",
    "lastClose",
    "windowChangePct",
    "skipped",
  ]);
  for (const [key, raw] of Object.entries(d)) {
    if (covered.has(key)) continue;
    if (isRecord(raw)) {
      const fields = Object.entries(raw).filter(
        ([, v]) => typeof v === "number" || typeof v === "boolean",
      );
      if (!fields.length) continue;
      const primary = fields.find(([, v]) => typeof v === "number");
      items.push({
        label: key,
        value: primary ? fmtNum(primary[1] as number) : String(fields[0][1]),
        sub:
          fields.length > 1
            ? fields
                .map(([k, v]) =>
                  `${k}: ${typeof v === "number" ? fmtNum(v) : String(v)}`
                )
                .join(" · ")
            : undefined,
      });
      continue;
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
      items.push({ label: key, value: fmtNum(raw) });
      continue;
    }
    // roc-style values are formatted strings ("1.2345").
    if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) {
      items.push({ label: key, value: fmtNum(Number(raw)) });
    }
  }

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

/**
 * crypto_market_structure →
 * { kind: "market_structure", symbol: { symbol, interval, half_width },
 *   last_close, candles, atr, er, trend, swings[], levels[], last_break, skipped[] }
 *
 * The structural card: the regime and the confirmed breaks up top, then the
 * clustered levels with their distance from price. `touches` is the whole
 * point of the card — a level tested three times is structure, one tested once
 * is a wick — so it leads every level cell.
 */
export function renderMarketStructure(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || d.kind !== "market_structure") return null;
  const meta = isRecord(d.symbol) ? d.symbol : {};
  const last = num(d.last_close);
  if (last === null || last === 0) return null;

  const trend = str(d.trend) ?? "range";
  const items: Metric[] = [
    {
      label: [str(meta.symbol), str(meta.interval), `${num(d.candles) ?? 0} candles`]
        .filter(Boolean)
        .join(" · "),
      value: fmtPrice(last),
      delta: trend,
      up: trend === "bullish" ? true : trend === "bearish" ? false : undefined,
      tone: trend === "bullish" ? "ok" : trend === "bearish" ? "danger" : "warn",
    },
  ];

  const atr = num(d.atr);
  if (atr !== null) {
    items.push({
      label: "ATR 14",
      value: fmtPrice(atr),
      sub: `${fmtPct((atr / last) * 100)}% of price`,
    });
  }
  const er = num(d.er);
  if (er !== null) {
    items.push({ label: "Efficiency 14", value: er.toFixed(2), sub: "regime filter" });
  }

  const brk = isRecord(d.last_break) ? d.last_break : null;
  const level = brk ? num(brk.level) : null;
  if (brk && level !== null) {
    const up = str(brk.direction) === "up";
    const ago = num(brk.bars_ago) ?? 0;
    items.push({
      label: "Last break",
      value: fmtPrice(level),
      sub: `${up ? "resistance broken" : "support broken"} · ${ago} ${ago === 1 ? "bar" : "bars"} ago`,
      delta: up ? "bullish" : "bearish",
      up,
    });
  }

  const levels = Array.isArray(d.levels) ? d.levels.filter(isRecord) : [];
  const levelItems: Metric[] = levels.slice(0, 8).map((l) => {
    const price = num(l.price);
    const touches = num(l.touches) ?? 0;
    const age = num(l.last_touch_age) ?? 0;
    const support = str(l.side) === "support";
    // Precomputed by the engine: the same arithmetic on both sides would drift.
    const distance = num(l.distance_pct);
    const sub = [
      distance !== null ? `${distance >= 0 ? "+" : ""}${fmtPct(distance)}% vs price` : null,
      age > 0 ? `${age} ${age === 1 ? "bar" : "bars"} old` : "on the last bar",
    ]
      .filter(Boolean)
      .join(" · ");
    return {
      label: `${support ? "Support" : "Resistance"} · ${touches}×`,
      value: price !== null ? fmtPrice(price) : "—",
      sub,
      tone: support ? "ok" : "warn",
    };
  });

  const half = num(meta.half_width) ?? 2;
  const swings = Array.isArray(d.swings) ? d.swings.length : 0;
  const skipped = Array.isArray(d.skipped)
    ? d.skipped
        .map((s) => (isRecord(s) && typeof s.name === "string" ? s.name : null))
        .filter((s): s is string => s !== null)
    : [];

  return (
    <TextCard>
      <MetricGrid items={items} />
      {levelItems.length > 0 && (
        <div className="mt-2">
          <MetricGrid items={levelItems} />
        </div>
      )}
      <Footnote>
        {`${swings} confirmed swing${swings === 1 ? "" : "s"} · pivots need ${half} closed bars on each side, so the last ${half} bars can never be one`}
      </Footnote>
      {skipped.length > 0 && <Footnote>Not enough history for: {skipped.join(", ")}</Footnote>}
    </TextCard>
  );
}

// ── binance_futures_audit_data ─────────────────────────────────────────────

/**
 * binance_futures_audit_data →
 * { kind: "audit_data", interval, usdmPositions, selected, warmed, errors,
 *   errorsTotal }.
 *
 * Phase 1 of the audit pipeline: the PRODUCT is the warm candle cache, so
 * this report is coverage bookkeeping — how many positions exist, how many
 * the grading step will fold, how many candle sets made it warm.
 */
export function renderBinanceFuturesAuditData(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || d.kind !== "audit_data") return null;
  const usdm = num(d.usdmPositions) ?? 0;
  const coinm = num(d.coinmPositions) ?? 0;
  const selected = num(d.selected) ?? 0;
  const warmed = num(d.warmed) ?? 0;
  const errorsTotal = num(d.errorsTotal) ?? 0;
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="database" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Position data
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">{str(d.interval) ?? ""}</span>
      </div>
      <p className="text-muted-foreground font-mono text-[11px]">
        Synced {fmtNum(usdm)} USDⓈ-M
        {coinm > 0 ? ` + ${fmtNum(coinm)} COIN-M` : ""} open position
        {usdm + coinm === 1 ? "" : "s"}; warming candles for the {fmtNum(selected)} largest
        exposure{selected === 1 ? "" : "s"} ({fmtNum(warmed)} warmed) — the grading report below
        reuses this data.
      </p>
      {errorsTotal > 0 && (
        <Footnote>{fmtNum(errorsTotal)} position(s) unreachable during the fetch.</Footnote>
      )}
    </TextCard>
  );
}

// ── binance_futures_risk_audit ─────────────────────────────────────────────

/**
 * binance_futures_risk_audit →
 * { params: { interval, risk, limit },
 *   summary: { usdmPositions, graded, skippedByCap, withStopLoss, naked,
 *              nakedNotional, withTakeProfit, slVerdicts, coinmPositions,
 *              usdm: {positions, graded, naked, …}, coinm: {…} },
 *   coinmUnrealizedPnlByAsset, positions: [{ margin, symbol, positionSide,
 *   positionAmt, markPrice, unRealizedProfit, notionalAbs, marginAsset,
 *   stopLoss{present,price,distancePct}, takeProfit{present,resting,…},
 *   riskReward, restingStops, restingTps, graded,
 *   advice{verdict,recommended{price,method,…},notes,error, takeProfit{…}} }],
 *   note }.
 *
 * The headline is EXPOSURE AT RISK, not a count: `nakedNotional` is the money
 * a single adverse tick can take, and a report that renders "183 unprotected"
 * in the same neutral tile as "183 graded" reads as calm. Every total spans
 * BOTH futures markets — the denominator is `usdmPositions + coinmPositions`
 * (dividing by USDⓈ-M alone once printed "200/184 graded"). The report reads
 * as TWO market cards (USDⓈ-M / COIN-M) under one whole-book banner because
 * the books are different CURRENCIES: COIN-M size is contracts (face USD) and
 * its PnL rides the settlement coin, suffixed per row. Tables are capped WITH
 * the hidden count stated, never silently sliced.
 */

/** Rows rendered before the "show all" disclosure. A 183-position book must
 * not dump 183 rows into a report the user is meant to read top-down. */
const AUDIT_ROW_CAP = 12;

/** One chip's palette. `warn` is the in-between: protection exists but the
 * engine thinks it is mistimed (tighten/loosen/too_close/too_far) — worth
 * reading, not worth panicking about. */
const CHIP_TONE: Record<string, string> = {
  ok: "border-success/30 bg-success/10 text-success",
  warn: "border-warning/30 bg-warning/10 text-warning",
  danger: "border-destructive/30 bg-destructive/10 text-destructive",
  mute: "border-border bg-muted/40 text-muted-foreground",
};

/** Verdict vocabulary is the engine's (stop_loss.rs / take_profit.rs), not
 * ours: `ok`/`tighten`/`loosen` for stops, `ok`/`too_close`/`too_far`/
 * `trailing` for take-profits, `missing` for either, plus the frontend's own
 * `error`/`ungraded` for a row the backend could not grade. Anything unknown
 * degrades to muted rather than being coloured as safe. */
function verdictTone(v: string): keyof typeof CHIP_TONE {
  if (v === "ok") return "ok";
  if (v === "missing" || v === "error" || v === "ungraded") return "danger";
  if (v === "tighten" || v === "loosen" || v === "too_close" || v === "too_far") {
    return "warn";
  }
  return "mute";
}

function VerdictChip({ verdict }: { verdict: string }) {
  const tone = verdictTone(verdict);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 rounded-sm border px-1 py-px font-mono text-[10px] tracking-wide uppercase",
        CHIP_TONE[tone]
      )}
    >
      {verdict.replace(/_/g, " ")}
    </span>
  );
}

/** Numeric cell. Values are aligned right + tabular so a column of prices can
 * be compared down the page instead of re-read one row at a time. */
function Num({ value, tone }: { value: string; tone?: "up" | "down" | "mute" }) {
  return (
    <td
      className={cn(
        "px-2 py-1.5 text-right whitespace-nowrap tabular-nums",
        tone === "up" && "text-success",
        tone === "down" && "text-destructive",
        (tone === "mute" || !tone) && "text-muted-foreground"
      )}
    >
      {value}
    </td>
  );
}

function AuditPositionTable({ rows }: { rows: Record<string, unknown>[] }) {
  const [expanded, setExpanded] = useState(false);
  const capped = rows.length > AUDIT_ROW_CAP;
  const visible = expanded ? rows : rows.slice(0, AUDIT_ROW_CAP);
  return (
    <div className="space-y-1.5">
      <div className="border-border/60 max-h-[26rem] overflow-auto rounded-md border">
        <table className="w-full border-collapse font-mono text-[11px]">
          <thead className="bg-muted/50 sticky top-0 z-10">
            <tr className="text-muted-foreground border-border/60 border-b text-left">
              <th className="px-2 py-1.5 font-medium">Position</th>
              <th className="px-2 py-1.5 text-right font-medium">Notional</th>
              <th className="px-2 py-1.5 text-right font-medium">PnL</th>
              <th className="px-2 py-1.5 font-medium" title="Closes the position at a loss if the price moves against you">
                Stop (exit at a loss)
              </th>
              <th className="px-2 py-1.5 font-medium" title="Closes part of the position at a profit">
                Targets (exit at a profit)
              </th>
              <th
                className="px-2 py-1.5 text-right font-medium"
                title="For every 1 put at risk at the stop, how much the first target pays back"
              >
                Risk : Reward
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((p, i) => {
              const advice = isRecord(p.advice) ? p.advice : {};
              const rec = isRecord(advice.recommended) ? advice.recommended : {};
              const notes = Array.isArray(advice.notes)
                ? advice.notes.filter((n): n is string => typeof n === "string")
                : [];
              const sl = isRecord(p.stopLoss) ? p.stopLoss : {};
              const tp = isRecord(p.takeProfit) ? p.takeProfit : {};
              const tpAdvice = isRecord(advice.takeProfit) ? advice.takeProfit : {};
              // The recommended ladder — `advice.takeProfit`, NOT the resting
              // coverage in `takeProfit`. Reading the latter showed a bare
              // "missing" chip on a book with no resting TPs while the engine's
              // 1R/2R rungs and trailing exit sat unrendered beside it.
              const tpRungs = (Array.isArray(tpAdvice.rungs) ? tpAdvice.rungs : [])
                .filter(isRecord)
                // A passed rung's exit window is gone — it is never placed.
                .filter((r) => r.passed !== true)
                .map((r) => ({
                  label: str(r.label) ?? "",
                  price: num(r.price),
                  allocPct: num(r.allocPct),
                }))
                .filter((r) => r.price !== null);
              const bandExit = isRecord(tpAdvice.bandExit)
                ? { method: str(tpAdvice.bandExit.method), price: num(tpAdvice.bandExit.price) }
                : null;
              const trailingExit = isRecord(tpAdvice.trailingExit)
                ? { method: str(tpAdvice.trailingExit.method), price: num(tpAdvice.trailingExit.price) }
                : null;
              const slPresent = sl.present === true;
              const tpPresent = tp.present === true;
              const slPrice = num(sl.price);
              const slDist = num(sl.distancePct);
              const tpPrice = num(tp.nearestPrice);
              const tpDist = num(tp.distancePct);
              const rr = num(p.riskReward);
              const pnl = num(p.unRealizedProfit);
              const symbol = str(p.symbol) ?? "Position";
              const side = (str(p.positionSide) ?? "").toUpperCase();
              const asset = str(p.marginAsset);
              // COIN-M PnL is denominated in the SETTLEMENT COIN, not USD —
              // a bare "-0.0001188" next to USDT-pair numbers reads as ~zero
              // USD. The unit rides the value.
              const isCoinm = str(p.margin) === "COINM";
              const pnlText =
                pnl !== null ? `${fmtSigned(pnl)}${isCoinm && asset ? ` ${asset}` : ""}` : "—";
              // Side is a direction, not a quality — it stays muted so the
              // only coloured thing in the row is the protection verdict.
              const verdict =
                str(advice.verdict) ?? (advice.error !== undefined || p.error !== undefined ? "error" : "ungraded");
              const tpVerdict = str(tpAdvice.verdict);
              const notional = num(p.notionalAbs);
              const recPrice = num(rec.price);
              const recMethod = str(rec.method);
              // The resting stop sits at/beyond entry: it grades `ok` exactly
              // like a stop that merely happens to align, but the remaining
              // decision differs — "trail it higher", never "roll it back".
              // Only the flag separates those, so it gets its own chip.
              const profitLocked = advice.profitLocked === true;
              // The other valid candidates, loosest→tightest. Surfaced only on
              // a locked stop: that is the one case where the engine
              // deliberately declines a level, and an operator deciding
              // whether to trail needs to see the structural level it passed
              // on. On every other row it is noise beside the recommendation.
              const alternatives = (Array.isArray(advice.alternatives) ? advice.alternatives : [])
                .filter(isRecord)
                .map((c) => ({ price: num(c.price), method: str(c.method) }))
                .filter((c) => c.price !== null);
              // `riskReward` grades the RESTING pair, so it is null on a naked
              // book — exactly where this column matters most. Fall back to the
              // ratio the recommended stop and first target would create,
              // measured from ENTRY (what the 1R/2R rungs are anchored to),
              // not from the mark, which has already run past a deep loss.
              const entryPrice = num(p.entryPrice);
              const markPrice = num(p.markPrice) ?? 0;
              const rrShown =
                rr ??
                placedRR(
                  slPresent ? slPrice : recPrice,
                  tpRungs[0]?.price ?? trailingExit?.price ?? bandExit?.price ?? null,
                  entryPrice != null && entryPrice > 0 ? entryPrice : markPrice,
                );
              return (
                <tr
                  key={`${symbol}-${side}-${i}`}
                  className="border-border/40 hover:bg-muted/30 border-b last:border-b-0"
                  // The engine's own explanation of the verdict ("resting
                  // take-profit banks only 1.2R…") belongs to the row it
                  // grades, not to a hidden log — hovering reveals why.
                  title={notes.length > 0 ? notes.join(" · ") : undefined}
                >
                  <td className="px-2 py-1.5">
                    <div className="text-foreground font-medium">{symbol}</div>
                    <div className="text-muted-foreground">
                      {side ? `${side.toLowerCase()}${asset ? ` · ${asset}` : ""}` : (asset ?? "")}
                    </div>
                  </td>
                  <Num value={notional !== null ? fmtMoney(notional) : "—"} />
                  <Num
                    value={pnlText}
                    tone={pnl === null ? "mute" : pnl < 0 ? "down" : pnl > 0 ? "up" : "mute"}
                  />
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <VerdictChip verdict={verdict} />
                      {profitLocked && (
                        <span
                          className={cn(
                            "inline-flex shrink-0 rounded-sm border px-1 py-px font-mono text-[10px] tracking-wide uppercase",
                            CHIP_TONE.ok,
                          )}
                          title="This stop already sits at or beyond entry — the trade can no longer turn into a loss, and advice never rolls it back. The remaining move is to trail it higher."
                        >
                          profit locked
                        </span>
                      )}
                      {slPresent && slPrice !== null && (
                        <span className="text-muted-foreground tabular-nums">
                          {fmtPrice(slPrice)}
                          {slDist !== null && ` (${fmtPct(slDist)}%)`}
                        </span>
                      )}
                    </div>
                    {!slPresent && recPrice !== null && (
                      // The method is the engine's snake_case vocabulary
                      // (chandelier_exit / atr_3x / dc_20) — spaced out so it
                      // reads as a word beside the level it justifies.
                      <div className="text-muted-foreground/80 mt-0.5">
                        → {fmtPrice(recPrice)} suggested
                        {recMethod ? ` · ${recMethod.replace(/_/g, " ")}` : ""}
                      </div>
                    )}
                    {profitLocked && alternatives.length > 0 && (
                      <div
                        className="text-muted-foreground/80 mt-0.5"
                        title={alternatives
                          .map((c) => `${c.method?.replace(/_/g, " ") ?? "structural"} ${fmtPrice(c.price!)}`)
                          .join(" · ")}
                      >
                        declined{" "}
                        {alternatives.slice(0, 2).map((c) => fmtPrice(c.price!)).join(" / ")} — trail instead
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {tpPresent ? (
                      <div className="flex items-center gap-1.5">
                        {tpVerdict ? (
                          <VerdictChip verdict={tpVerdict} />
                        ) : (
                          <span
                            className={cn(
                              "inline-flex shrink-0 rounded-sm border px-1 py-px font-mono text-[10px] tracking-wide uppercase",
                              CHIP_TONE.ok
                            )}
                          >
                            covered
                          </span>
                        )}
                        {tpPrice !== null && (
                          <span className="text-muted-foreground tabular-nums">
                            {fmtPrice(tpPrice)}
                            {tpDist !== null && ` (${fmtPct(tpDist)}%)`}
                          </span>
                        )}
                      </div>
                    ) : (
                      // No resting take-profit: show what the engine would
                      // PLACE. The verdict chip stays regardless of whether a
                      // ladder came with it — "too close" on an empty ladder is
                      // still the reason the resting target is wrong.
                      <div className="space-y-1">
                        {tpVerdict && <VerdictChip verdict={tpVerdict} />}
                        <TpLadder
                          bandExit={bandExit?.price != null ? { method: bandExit.method ?? "", price: bandExit.price } : null}
                          rungs={tpRungs.map((r) => ({
                            label: r.label,
                            price: r.price as number,
                            allocPct: r.allocPct,
                          }))}
                          trailingExit={
                            trailingExit?.price != null
                              ? { method: trailingExit.method ?? "", price: trailingExit.price }
                              : null
                          }
                        />
                      </div>
                    )}
                  </td>
                  <Num value={rrShown !== null ? fmtRR(rrShown) : "—"} />
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {capped && (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground text-xs underline"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? `Show only the ${AUDIT_ROW_CAP} largest` : `Show all ${rows.length} positions`}
        </button>
      )}
    </div>
  );
}

export function renderBinanceFuturesRiskAudit(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !isRecord(d.summary)) return null;
  return <FuturesRiskAuditReport data={d} />;
}

/** Client-side fold of coverage rows into one family's stats — the same
 * shape the backend's `summary.usdm` / `summary.coinm` rollups carry. Only
 * needed for payloads from before those rollups existed; coverage still
 * reads the resting-order flags, so the numbers match the flat totals. */
function rollupRows(rows: Record<string, unknown>[]): Record<string, unknown> {
  let graded = 0;
  let withSl = 0;
  let withTp = 0;
  let nakedNotional = 0;
  for (const r of rows) {
    const sl = isRecord(r.stopLoss) ? r.stopLoss : {};
    const tp = isRecord(r.takeProfit) ? r.takeProfit : {};
    if (sl.present === true) withSl += 1;
    else nakedNotional += num(r.notional) ?? num(r.notionalAbs) ?? 0;
    if (tp.present === true) withTp += 1;
    if (r.graded === true) graded += 1;
  }
  return {
    positions: rows.length,
    graded,
    naked: rows.length - withSl,
    withStopLoss: withSl,
    withTakeProfit: withTp,
    nakedNotional,
  };
}

/** The four protection tiles for ONE market family. */
function familyTiles(stats: Record<string, unknown>): Metric[] {
  const positions = num(stats.positions) ?? 0;
  const naked = num(stats.naked) ?? 0;
  const withSl = num(stats.withStopLoss) ?? 0;
  const withTp = num(stats.withTakeProfit) ?? 0;
  const graded = num(stats.graded) ?? 0;
  const nakedNotional = num(stats.nakedNotional) ?? 0;
  return [
    {
      label: "Unprotected exposure",
      value: naked > 0 ? fmtMoney(nakedNotional) : fmtMoney(0),
      sub: `${fmtNum(naked)} of ${fmtNum(positions)} positions have no stop`,
      tone: naked > 0 ? "danger" : "ok",
    },
    { label: "With a stop", value: fmtNum(withSl) },
    {
      label: "With a take-profit",
      value: fmtNum(withTp),
      tone: withTp < positions ? "warn" : "ok",
    },
    { label: "Graded", value: `${fmtNum(graded)}/${fmtNum(positions)}` },
  ];
}

/**
 * The report reads as TWO CARDS — one per futures family — because the books
 * are different CURRENCIES: USDⓈ-M sizes are coins (USDT margin), COIN-M
 * sizes are contracts and its PnL rides the settlement coin. A slim banner
 * above them keeps the WHOLE-book answer (total exposure at risk, graded
 * fraction, skipped count, engine notes) in one place so neither family card
 * has to sum across currencies.
 */
function FuturesRiskAuditReport({ data: d }: { data: Record<string, unknown> }) {
  const s = d.summary as Record<string, unknown>;
  const usdm = num(s.usdmPositions) ?? 0;
  const naked = num(s.naked) ?? 0;
  const graded = num(s.graded) ?? 0;
  const skipped = num(s.skippedByCap) ?? 0;
  const nakedNotional = num(s.nakedNotional) ?? 0;
  const coinmCount = num(s.coinmPositions) ?? 0;
  // Both futures markets grade since COIN-M rode the dapi candle path — the
  // denominator is the WHOLE book, not just the USDⓈ-M family (a "200/184
  // graded" tile read as nonsense).
  const total = usdm + coinmCount;
  const params = isRecord(d.params) ? d.params : {};
  const market = str(params.market) ?? "all";
  const rows = (Array.isArray(d.positions) ? d.positions : []).filter(isRecord);

  // Rows default to the USDⓈ-M family: payloads from before COIN-M grading
  // carry no `margin` and were USDⓈ-M-only books.
  const usdmRows = rows.filter((r) => (str(r.margin) ?? "USDM") !== "COINM");
  const coinmRows = rows.filter((r) => r.margin === "COINM");
  // Family stats: backend rollups when present; older payloads fold the same
  // numbers client-side from the rows.
  const usdmStats = isRecord(s.usdm) ? s.usdm : rollupRows(usdmRows);
  const coinmStats = isRecord(s.coinm) ? s.coinm : rollupRows(coinmRows);

  const coinm = isRecord(d.coinmUnrealizedPnlByAsset) ? d.coinmUnrealizedPnlByAsset : {};
  const coinmLines = Object.entries(coinm)
    .filter(([, v]) => typeof v === "number" && v !== 0)
    .sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number));

  const usdmCardVisible =
    market !== "coinm" && (usdmRows.length > 0 || usdm > 0 || market === "usdm");
  const coinmCardVisible =
    market !== "usdm" && (coinmRows.length > 0 || coinmCount > 0 || market === "coinm");

  return (
    <div className="space-y-6">
      {/* ── Whole-book banner ── the combined answer in one slim card. */}
      <TextCard className="bg-background rounded-xl border shadow-sm p-3">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-muted-foreground text-xs">Unprotected exposure</span>
          <span
            className={cn(
              "font-semibold text-lg tabular-nums",
              naked > 0 ? "text-destructive" : "text-success"
            )}
          >
            {naked > 0 ? fmtMoney(nakedNotional) : fmtMoney(0)}
          </span>
          <span className="text-muted-foreground text-[11px]">
            {fmtNum(naked)} of {fmtNum(total)} positions have no stop · {fmtNum(graded)}/
            {fmtNum(total)} graded
            {skipped > 0 ? ` · ${fmtNum(skipped)} over the cap` : ""}
          </span>
        </div>
        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px]">
          {naked > 0 && (
            <span className="text-destructive inline-flex items-center gap-1">
              <Icon name="alert-circle" className="size-3.5" />
              no stop floor on any of them — an adverse move runs to liquidation
            </span>
          )}
          {naked === 0 && total > 0 && (
            <span className="text-success inline-flex items-center gap-1">
              <Icon name="check-circle-2" className="size-3.5" />
              every graded position carries a stop
            </span>
          )}
          {str(params.interval) && (
            <span>
              {str(params.interval)} candles · {str(params.risk) ?? "standard"} stop preset
            </span>
          )}
          {market !== "all" && <span>scoped to {market.toUpperCase()}</span>}
        </div>
        {str(d.note) && <Footnote>{str(d.note)}</Footnote>}
        {/* What the report could NOT cover, stated by the tool itself. A bare
            COIN-M PnL table next to no warning read as a completed analysis. */}
        {(Array.isArray(d.limitations) ? d.limitations : [])
          .filter((l): l is string => typeof l === "string" && l.length > 0)
          .map((l) => (
            <div
              key={l.slice(0, 40)}
              className="border-warning/30 bg-warning/5 flex items-start gap-1.5 rounded-md border px-2.5 py-2 text-xs"
            >
              <Icon name="alert-circle" className="text-warning mt-0.5 size-3.5 shrink-0" />
              <span className="text-muted-foreground">{l}</span>
            </div>
          ))}
        {skipped > 0 && (
          <Footnote>
            Re-run with a higher position cap to grade the {fmtNum(skipped)} smaller position
            {skipped > 1 ? "s" : ""}.
          </Footnote>
        )}
      </TextCard>

      {/* ── USDⓈ-M card ── USDT margin; sizes are coin amounts. */}
      {usdmCardVisible && (
        <TextCard className="bg-background rounded-xl border shadow-sm p-4">
          <div className="border-border/60 flex items-center gap-2 border-b pb-2">
            <span className="bg-primary size-2 shrink-0 rounded-full" />
            <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
              USDⓈ-M — USDT margin
            </span>
          </div>
          <MetricGrid items={familyTiles(usdmStats)} />
          {usdmRows.length > 0 ? (
            <AuditPositionTable rows={usdmRows} />
          ) : (
            <Footnote>No open USDⓈ-M positions.</Footnote>
          )}
        </TextCard>
      )}

      {/* ── COIN-M card ── coin-settled: sizes are CONTRACTS (face USD) and
             PnL rides the settlement coin, so it never mixes with USDT. */}
      {coinmCardVisible && (
        <TextCard className="bg-background rounded-xl border shadow-sm p-4">
          <div className="border-border/60 flex items-center gap-2 border-b pb-2">
            <span className="bg-warning size-2 shrink-0 rounded-full" />
            <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
              COIN-M — coin-settled · size in contracts · PnL per settlement coin
            </span>
          </div>
          {(coinmRows.length > 0 || isRecord(s.coinm)) && (
            <MetricGrid items={familyTiles(coinmStats)} />
          )}
          {coinmRows.length > 0 ? (
            <AuditPositionTable rows={coinmRows} />
          ) : (
            <Footnote>No open COIN-M positions.</Footnote>
          )}
          {coinmCount > 0 && (
            <details className="border-border/60 rounded-md border">
              <summary className="text-muted-foreground hover:text-foreground cursor-pointer px-2.5 py-2 text-xs select-none">
                {fmtNum(coinmCount)} COIN-M position{coinmCount > 1 ? "s" : ""}
                {coinmRows.length === 0 &&
                  ` · ${fmtNum(num(coinmStats.graded) ?? 0)}/${fmtNum(coinmCount)} graded · ${fmtNum(
                    num(coinmStats.naked) ?? 0
                  )} naked`}
                {coinmLines.length > 0 &&
                  " · unrealized PnL per settlement asset (never summed with USDT)"}
              </summary>
              {coinmLines.length > 0 && (
                <dl className="border-border/60 grid grid-cols-2 gap-x-3 gap-y-1 border-t px-2.5 py-2 font-mono text-[11px] sm:grid-cols-3">
                  {coinmLines.map(([asset, v]) => (
                    <div key={asset} className="flex justify-between gap-2">
                      <dt className="text-muted-foreground">{asset}</dt>
                      <dd
                        className={cn(
                          "tabular-nums",
                          (v as number) < 0
                            ? "text-destructive"
                            : (v as number) > 0
                              ? "text-success"
                              : "text-muted-foreground"
                        )}
                      >
                        {fmtSigned(v as number)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </details>
          )}
        </TextCard>
      )}
    </div>
  );
}

// ── crypto_screener_data ────────────────────────────────────────────────────

/**
 * crypto_screener_data →
 * { kind: "screener_data", universe, interval, scanned, universeData:
 *   [{symbol, last, change24hPct}], universeTotal, partial, errors,
 *   errorsTotal }.
 *
 * Phase 1 of the phased pipeline: its PRODUCT is the warmed candle cache —
 * the report only needs to say what got warmed and whether the phase is
 * partial, never dump the rows (the per-screen reports in phase 2 render
 * them).
 */
export function renderCryptoScreenerData(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || d.kind !== "screener_data") return null;
  const rows = Array.isArray(d.universeData) ? d.universeData.length : null;
  const scanned = num(d.scanned);
  const universe = str(d.universe) ?? "";
  const interval = str(d.interval) ?? "";
  const partial = d.partial === true;
  const errorsTotal = num(d.errorsTotal) ?? 0;
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="database" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Market data
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">
          {universe} · {interval}
        </span>
        {partial && (
          <span className="border-warning/30 bg-warning/10 text-warning rounded-sm border px-1 py-px font-mono text-[10px] uppercase">
            partial
          </span>
        )}
      </div>
      <p className="text-muted-foreground font-mono text-[11px]">
        Fetched candles for {rows !== null ? fmtNum(rows) : scanned !== null ? fmtNum(scanned) : "?"} symbol
        {(rows ?? scanned ?? 0) === 1 ? "" : "s"} — the per-screen reports below reuse this data (no refetch).
      </p>
      {errorsTotal > 0 && (
        <Footnote>{fmtNum(errorsTotal)} symbol(s) unreachable during the fetch.</Footnote>
      )}
    </TextCard>
  );
}

// ── crypto_screener ─────────────────────────────────────────────────────────

/**
 * crypto_screener →
 * { kind: "screener", screen, direction, universe, interval, scanned,
 *   skipped, hits: [{ symbol, last, change24hPct, score, reasons: [..],
 *     structure: { trend, nearestLevel: { price, side, distancePct, touches,
 *     lastTouchAge }, lastBreak: { direction, level, barsAgo } } | null }],
 *   hitsTotal, topN, universeTotal, partial, errors, errorsTotal,
 *   structureFiltered, structureFilter: { side, maxDistancePct, minTouches } | null }.
 *
 * The headline is the HIT TABLE ranked by conviction score — the score IS the
 * engine's ranking, so the table preserves it verbatim (no re-sort). Reasons
 * ride the row (why it fired is the payload a screener sells), direction and
 * coverage (scanned / partial) ride the header.
 *
 * The STRUCTURE column is context for the setup, not a second score: the
 * nearest confirmed level with its touch count and SIGNED distance (`-1.6%`
 * = the level sits below price, i.e. already broken), the level type (R/S)
 * and the trend/break on hover. It only appears when the payload carries it,
 * so an older hit list renders exactly as before. `structureFiltered` names
 * hits the structural filter removed, so a narrowed pass never reads as an
 * unfiltered market with no signals.
 */

/** Score chip palette: ≥80 reads as actionable, ≥60 as worth a look, below
 * stays muted — a screener table where every row shouts is no signal. */
function scoreTone(score: number): "ok" | "warn" | "mute" {
  if (score >= 80) return "ok";
  if (score >= 60) return "warn";
  return "mute";
}

const SCREENER_ROW_CAP = 12;

/**
 * One hit's structural context. The SIGN of the distance is the fact a reader
 * acts on (`-1.6%` = the level sits below price, i.e. it has already been
 * broken), so it is printed rather than implied; the level TYPE (R/S) comes
 * from the pivot kind and is not the same thing as the side of price.
 */
function StructureCell({ structure }: { structure: unknown }) {
  if (!isRecord(structure)) {
    return <td className="text-muted-foreground px-2 py-1.5 text-right">—</td>;
  }
  const trend = str(structure.trend);
  const level = isRecord(structure.nearestLevel) ? structure.nearestLevel : null;
  const brk = isRecord(structure.lastBreak) ? structure.lastBreak : null;
  const price = level ? num(level.price) : null;
  const side = level ? str(level.side) : null;
  const dist = level ? num(level.distancePct) : null;
  const touches = level ? num(level.touches) : null;
  const breakDir = brk ? str(brk.direction) : null;
  const breakLevel = brk ? num(brk.level) : null;
  const breakAgo = brk ? num(brk.barsAgo) : null;
  const title = [
    trend ? `trend ${trend}` : null,
    breakDir && breakLevel !== null
      ? `last break ${breakDir} ${fmtPrice(breakLevel)}${breakAgo !== null ? ` (${breakAgo} bars ago)` : ""}`
      : "no structural break",
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <td className="px-2 py-1.5 text-right whitespace-nowrap" title={title}>
      {level && price !== null ? (
        <div className="flex items-center justify-end gap-1.5">
          <span
            className={cn(
              "font-mono text-[10px] font-bold",
              side === "resistance" ? "text-warning" : "text-success"
            )}
          >
            {side === "resistance" ? "R" : side === "support" ? "S" : "?"}
          </span>
          <span className="text-foreground tabular-nums">{fmtPrice(price)}</span>
          <span className="text-muted-foreground tabular-nums">
            {dist !== null ? `${dist > 0 ? "+" : ""}${fmtPct(dist)}%` : "—"}
            {touches !== null ? ` · ${touches}×` : ""}
          </span>
        </div>
      ) : (
        <span className="text-muted-foreground">—</span>
      )}
    </td>
  );
}

export function renderCryptoScreener(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.hits)) return null;
  const hits = d.hits.filter(isRecord);
  if (hits.length === 0 && d.scanned === undefined) return null;
  // Multi-screen runs carry `screens` (the requested set) and tag every hit
  // row with its screen; single-screen runs keep the bare `screen` name.
  const screensList = (Array.isArray(d.screens) ? d.screens : []).filter(
    (s): s is string => typeof s === "string"
  );
  const multi = screensList.length > 1;
  const screen = str(d.screen) ?? screensList.join(", ");
  const direction = str(d.direction) ?? "";
  const universe = str(d.universe) ?? "";
  const interval = str(d.interval) ?? "";
  const scanned = num(d.scanned);
  const hitsTotal = num(d.hitsTotal);
  const partial = d.partial === true;
  const errorsTotal = num(d.errorsTotal) ?? 0;
  const capped = hits.length > SCREENER_ROW_CAP;
  const perScreen = (Array.isArray(d.perScreen) ? d.perScreen : []).filter(isRecord);
  // Structural context is optional per hit (a series too short to fold has
  // none): the column appears only when at least one row can fill it.
  const hasStructure = hits.some(
    (h) => isRecord(h.structure) && isRecord(h.structure.nearestLevel)
  );
  const structureFiltered = num(d.structureFiltered) ?? 0;
  const structureFilter = isRecord(d.structureFilter) ? d.structureFilter : null;

  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="scan-search" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          {multi ? `${screensList.length} setups · one scan` : screen.replace(/_/g, " ") || "Screener"}
        </span>
        <span
          className={cn(
            "rounded-sm border px-1 py-px font-mono text-[10px] tracking-wide uppercase",
            direction === "bullish"
              ? "border-success/30 bg-success/10 text-success"
              : direction === "bearish"
                ? "border-destructive/30 bg-destructive/10 text-destructive"
                : "border-border bg-muted/40 text-muted-foreground"
          )}
        >
          {direction}
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">
          {universe} · {interval}
        </span>
        {partial && (
          <span className="border-warning/30 bg-warning/10 text-warning rounded-sm border px-1 py-px font-mono text-[10px] uppercase">
            partial
          </span>
        )}
        {structureFiltered > 0 && (
          <span
            className="border-border bg-muted/40 text-muted-foreground rounded-sm border px-1 py-px font-mono text-[10px] uppercase"
            title={[
              "hits dropped by the structural filter",
              structureFilter
                ? [
                    structureFilter.side ? `side ${str(structureFilter.side)}` : null,
                    num(structureFilter.maxDistancePct) !== null
                      ? `within ${fmtPct(num(structureFilter.maxDistancePct) ?? 0)}% of price`
                      : null,
                    num(structureFilter.minTouches) !== null
                      ? `${num(structureFilter.minTouches)}x touches`
                      : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : null,
            ]
              .filter(Boolean)
              .join(" — ")}
          >
            -{structureFiltered} structure
          </span>
        )}
      </div>

      {hits.length > 0 ? (
        <div className="border-border/60 max-h-[26rem] overflow-auto rounded-md border">
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead className="bg-muted/50 sticky top-0 z-10">
              <tr className="text-muted-foreground border-border/60 border-b text-left">
                {multi && <th className="px-2 py-1.5 font-medium">Setup</th>}
                <th className="px-2 py-1.5 font-medium">Symbol</th>
                <th className="px-2 py-1.5 text-right font-medium">Last</th>
                <th className="px-2 py-1.5 text-right font-medium">24h</th>
                {hasStructure && (
                  <th
                    className="px-2 py-1.5 text-right font-medium"
                    title="Nearest confirmed level (pivot scan shared with the stop policy) — touches and signed distance from the last close"
                  >
                    Structure
                  </th>
                )}
                <th className="px-2 py-1.5 text-right font-medium" title="The engine's conviction ranking, 0-100">
                  Score
                </th>
                <th className="px-2 py-1.5 font-medium">Why it fired</th>
              </tr>
            </thead>
            <tbody>
              {(capped ? hits.slice(0, SCREENER_ROW_CAP) : hits).map((h, i) => {
                const symbol = str(h.symbol) ?? "?";
                const hitScreen = str(h.screen);
                const last = num(h.last);
                const chg = num(h.change24hPct);
                const score = num(h.score) ?? 0;
                const reasons = (Array.isArray(h.reasons) ? h.reasons : []).filter(
                  (r): r is string => typeof r === "string"
                );
                const tone = scoreTone(score);
                return (
                  <tr
                    key={`${hitScreen ?? ""}-${symbol}-${i}`}
                    className="border-border/40 hover:bg-muted/30 border-b last:border-b-0"
                    title={reasons.join(" · ")}
                  >
                    {multi && (
                      <td className="text-muted-foreground max-w-[9rem] px-2 py-1.5">
                        <span className="truncate">{hitScreen?.replace(/_/g, " ")}</span>
                      </td>
                    )}
                    <td className="text-foreground px-2 py-1.5 font-medium">{symbol}</td>
                    <td className="text-muted-foreground px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                      {last !== null ? fmtPrice(last) : "—"}
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right whitespace-nowrap tabular-nums",
                        chg === null ? "text-muted-foreground" : chg < 0 ? "text-destructive" : "text-success"
                      )}
                    >
                      {chg !== null ? `${chg > 0 ? "+" : ""}${fmtPct(chg)}` : "—"}
                    </td>
                    {hasStructure && <StructureCell structure={h.structure} />}
                    <td className="px-2 py-1.5 text-right">
                      <span
                        className={cn(
                          "rounded-sm border px-1 py-px font-mono text-[10px] tracking-wide",
                          tone === "ok"
                            ? "border-success/30 bg-success/10 text-success"
                            : tone === "warn"
                              ? "border-warning/30 bg-warning/10 text-warning"
                              : "border-border bg-muted/40 text-muted-foreground"
                        )}
                      >
                        {score}
                      </span>
                    </td>
                    <td className="text-muted-foreground max-w-[22rem] px-2 py-1.5">
                      <span className="line-clamp-2">{reasons.join(" · ")}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-muted-foreground font-mono text-[11px]">
          No symbols fired this pass — a screen firing is market-dependent, not guaranteed.
        </p>
      )}

      <Footnote>
        {scanned !== null ? fmtNum(scanned) : "?"} symbols scanned
        {multi
          ? ` · ${perScreen
              .map((p) => `${str(p.screen)?.replace(/_/g, " ")}: ${fmtNum(num(p.hits) ?? 0)}`)
              .join(", ")}`
          : hitsTotal !== null && hitsTotal > hits.length
            ? ` · top ${hits.length} of ${fmtNum(hitsTotal)} hits`
            : ""}
        {errorsTotal > 0 ? ` · ${fmtNum(errorsTotal)} symbol(s) unreachable` : ""}
        {capped ? " · showing the strongest rows" : ""}
      </Footnote>
    </TextCard>
  );
}
