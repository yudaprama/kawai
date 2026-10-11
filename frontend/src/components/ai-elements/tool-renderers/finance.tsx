import { useState, type ReactNode } from "react";
import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";
import { parse, isRecord, num, str, fmtNum, fmtPrice, fmtMoney, fmtPct, fmtSigned, MetricGrid, ChartCard, Footnote, TextCard, cards, type CardItem, type Metric, type Series } from "./shared";

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
 */
export function renderBinanceFuturesPositions(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || !Array.isArray(d.positions)) return null;
  const positions: CardItem[] = d.positions
    .filter(isRecord)
    .map((p) => {
      const side = str(p.positionSide)?.toUpperCase();
      const amt = num(p.positionAmt);
      const entry = num(p.entryPrice);
      const mark = num(p.markPrice);
      const pnl = num(p.unRealizedProfit);
      const liq = num(p.liquidationPrice);
      const notional = num(p.notional);
      const market = str(p.margin)?.toUpperCase();
      const tag = market === "COINM" ? "COIN-M" : market === "USDM" ? undefined : market;
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

  const orders: CardItem[] = (Array.isArray(d.openOrders) ? d.openOrders : [])
    .filter(isRecord)
    .map((o) => {
      const intent = str(o.intent)?.toUpperCase();
      const kind = str(o.type)?.replace(/_/g, " ");
      const qty = num(o.origQty);
      const price = num(o.price);
      const stop = num(o.stopPrice);
      // Stop/TP orders carry their level in stopPrice; a plain limit uses price.
      const level = stop !== null && stop > 0 ? stop : price;
      return {
        title: [str(o.symbol), intent ?? kind].filter(Boolean).join(" ") || "Order",
        subtitle:
          qty !== null ? `${fmtNum(qty)} @ ${level !== null && level > 0 ? fmtNum(level) : "market"}` : undefined,
        meta: [
          ...(str(o.margin)?.toUpperCase() === "COINM" ? ["COIN-M"] : []),
          ...(kind !== undefined ? [kind] : []),
          str(o.side)?.toUpperCase(),
          ...(o.reduceOnly === true ? ["reduce-only"] : []),
          ...(o.closePosition === true ? ["close-position"] : []),
        ]
          .filter(Boolean)
          .join(" · "),
      };
    });

  if (!positions.length && !orders.length) {
    return (
      <TextCard>
        <Footnote>No open Binance futures positions or orders.</Footnote>
      </TextCard>
    );
  }
  const total = num(d.totalUnrealizedPnl);
  // COIN-M PnL is denominated in the settlement coin, so it is NEVER summed
  // into the USDT total — each asset renders as its own line.
  const coinm = isRecord(d.coinmUnrealizedPnlByAsset) ? d.coinmUnrealizedPnlByAsset : {};
  const coinmLines = Object.entries(coinm).filter(
    ([, v]) => typeof v === "number" && v !== 0,
  );
  return (
    <>
      {cards(positions)}
      {orders.length ? (
        <>
          <div className="not-prose pt-2 text-muted-foreground text-xs font-medium uppercase">
            Open orders
          </div>
          {cards(orders)}
        </>
      ) : null}
      {total !== null ? <Footnote>Total unrealized PnL (USDⓈ-M) {fmtNum(total)}</Footnote> : null}
      {coinmLines.map(([asset, v]) => (
        <Footnote key={asset}>
          COIN-M unrealized PnL ({asset}) {fmtNum(v as number)}
        </Footnote>
      ))}
    </>
  );
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

// ── binance_futures_risk_audit ─────────────────────────────────────────────

/**
 * binance_futures_risk_audit →
 * { params: { interval, risk, limit },
 *   summary: { usdmPositions, graded, skippedByCap, withStopLoss, naked,
 *              nakedNotional, withTakeProfit, slVerdicts, coinmPositions },
 *   coinmUnrealizedPnlByAsset, positions: [{ symbol, positionSide,
 *   positionAmt, markPrice, unRealizedProfit, notionalAbs, marginAsset,
 *   stopLoss{present,price,distancePct}, takeProfit{present,resting,…},
 *   riskReward, restingStops, restingTps, graded,
 *   advice{verdict,recommended{price,method,…},notes,error, takeProfit{…}} }],
 *   note }.
 *
 * The headline is EXPOSURE AT RISK, not a count: `nakedNotional` is the money
 * a single adverse tick can take, and a report that renders "183 unprotected"
 * in the same neutral tile as "183 graded" reads as calm. Rows follow as a
 * scannable table (aligned numeric columns, severity-toned verdict chips)
 * because position coverage is a comparison, not a prose list — and they are
 * capped WITH the hidden count stated, never silently sliced.
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
              <th className="px-2 py-1.5 font-medium">Stop</th>
              <th className="px-2 py-1.5 font-medium">Take-profit</th>
              <th className="px-2 py-1.5 text-right font-medium">R:R</th>
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
              // Side is a direction, not a quality — it stays muted so the
              // only coloured thing in the row is the protection verdict.
              const verdict =
                str(advice.verdict) ?? (advice.error !== undefined || p.error !== undefined ? "error" : "ungraded");
              const tpVerdict = str(tpAdvice.verdict);
              const notional = num(p.notionalAbs);
              const recPrice = num(rec.price);
              const recMethod = str(rec.method);
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
                    value={pnl !== null ? fmtSigned(pnl) : "—"}
                    tone={pnl === null ? "mute" : pnl < 0 ? "down" : pnl > 0 ? "up" : "mute"}
                  />
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <VerdictChip verdict={verdict} />
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
                  </td>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      {tpVerdict ? (
                        <VerdictChip verdict={tpVerdict} />
                      ) : (
                        <span
                          className={cn(
                            "inline-flex shrink-0 rounded-sm border px-1 py-px font-mono text-[10px] tracking-wide uppercase",
                            CHIP_TONE[tpPresent ? "ok" : "mute"]
                          )}
                        >
                          {tpPresent ? "covered" : "none"}
                        </span>
                      )}
                      {tpPresent && tpPrice !== null && (
                        <span className="text-muted-foreground tabular-nums">
                          {fmtPrice(tpPrice)}
                          {tpDist !== null && ` (${fmtPct(tpDist)}%)`}
                        </span>
                      )}
                    </div>
                  </td>
                  <Num value={rr !== null ? `${fmtPct(rr)}R` : "—"} />
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
  return <FuturesRiskAuditCard data={d} />;
}

function FuturesRiskAuditCard({ data: d }: { data: Record<string, unknown> }) {
  const s = d.summary as Record<string, unknown>;
  const usdm = num(s.usdmPositions) ?? 0;
  const naked = num(s.naked) ?? 0;
  const graded = num(s.graded) ?? 0;
  const skipped = num(s.skippedByCap) ?? 0;
  const withSl = num(s.withStopLoss) ?? 0;
  const withTp = num(s.withTakeProfit) ?? 0;
  const nakedNotional = num(s.nakedNotional) ?? 0;
  const coinmCount = num(s.coinmPositions) ?? 0;
  const params = isRecord(d.params) ? d.params : {};
  const rows = (Array.isArray(d.positions) ? d.positions : []).filter(isRecord);

  // Exposure at risk leads, in the currency the numbers are actually in.
  const summary: Metric[] = [
    {
      label: "Unprotected exposure",
      value: naked > 0 ? fmtMoney(nakedNotional) : fmtMoney(0),
      sub: `${fmtNum(naked)} of ${fmtNum(usdm)} positions have no stop`,
      tone: naked > 0 ? "danger" : "ok",
    },
    { label: "With a stop", value: fmtNum(withSl) },
    {
      label: "With a take-profit",
      value: fmtNum(withTp),
      tone: withTp < usdm ? "warn" : "ok",
    },
    {
      label: "Graded",
      value: `${fmtNum(graded)}/${fmtNum(usdm)}`,
      ...(skipped > 0 ? { sub: `${fmtNum(skipped)} over the cap` } : {}),
      ...(skipped > 0 ? { tone: "warn" as const } : {}),
    },
  ];

  const coinm = isRecord(d.coinmUnrealizedPnlByAsset) ? d.coinmUnrealizedPnlByAsset : {};
  const coinmLines = Object.entries(coinm)
    .filter(([, v]) => typeof v === "number" && v !== 0)
    .sort((a, b) => Math.abs(b[1] as number) - Math.abs(a[1] as number));

  return (
    <TextCard>
      <MetricGrid items={summary} />
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px]">
        {naked > 0 && (
          <span className="text-destructive inline-flex items-center gap-1">
            <Icon name="alert-circle" className="size-3.5" />
            no stop floor on any of them — an adverse move runs to liquidation
          </span>
        )}
        {naked === 0 && usdm > 0 && (
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
      </div>
      {rows.length > 0 ? (
        <AuditPositionTable rows={rows} />
      ) : (
        <Footnote>No open USDⓈ-M positions.</Footnote>
      )}
      {coinmCount > 0 && (
        <details className="border-border/60 rounded-md border">
          <summary className="text-muted-foreground hover:text-foreground cursor-pointer px-2.5 py-2 text-xs select-none">
            {fmtNum(coinmCount)} COIN-M position{coinmCount > 1 ? "s" : ""} counted, not klines-audited
            {coinmLines.length > 0 && " · unrealized PnL by settlement asset"}
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
      {str(d.note) && <Footnote>{str(d.note)}</Footnote>}
      {skipped > 0 && (
        <Footnote>
          Re-run with a higher position cap to grade the {fmtNum(skipped)} smaller position
          {skipped > 1 ? "s" : ""}.
        </Footnote>
      )}
    </TextCard>
  );
}
