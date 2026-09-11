import type { ReactNode } from "react";

import { fmtDate, fmtNumber, fmtPct, isRecord, pick, toNum } from "./format";
import { KeyValueView, Pill, RecordListView, SectionLabel } from "./atoms";
import { GenericHumanView } from "./generic-views";

/** [label, formatted number | null] helper for KeyValueView. */
function kvNum(label: string, v: unknown, opts?: Intl.NumberFormatOptions): [string, ReactNode] {
  const n = toNum(v);
  return [label, n != null ? fmtNumber(n, opts) : null];
}

// ── stock-quote ─────────────────────────────────────────────────────────────

/** Inline SVG sparkline for a close-price series (get_stock_history). */
export function SparklineView({ closes, label }: { closes: number[]; label: string }) {
  if (closes.length < 2) return null;
  const w = 560;
  const h = 120;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes
    .map((c, i) => `${(i / (closes.length - 1)) * w},${h - ((c - min) / span) * (h - 12) - 6}`)
    .join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  const stroke = up ? "text-success" : "text-destructive";
  const delta = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3">
        <span className="text-muted-foreground text-xs">{label}</span>
        <Pill tone={up ? "up" : "down"}>
          {up ? "▲" : "▼"} {fmtPct(Math.abs(delta))} selama periode ini
        </Pill>
      </div>
      <svg
        className={`${stroke} w-full`}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${w} ${h}`}
        aria-label="Grafik harga"
      >
        <title>Grafik harga</title>
        <polyline fill="none" points={pts} stroke="currentColor" strokeWidth="2" />
      </svg>
      <div className="text-muted-foreground flex justify-between font-mono text-[11px]">
        <span>terendah {fmtNumber(min)}</span>
        <span>tertinggi {fmtNumber(max)}</span>
      </div>
    </div>
  );
}

/** get_stock_price / get_stock_quote / get_stock_detail — big number + delta. */
export function StockQuoteView({ data }: { data: Record<string, unknown> }) {
  const price = toNum(pick(data, "price", "close", "regularMarketPrice"));
  const symbol = pick<string>(data, "symbol", "ticker") ?? "";
  const name = pick<string>(data, "name", "instrument_name", "shortName");
  if (price == null && !symbol) return null;
  const change = toNum(pick(data, "change"));
  const pct = toNum(pick(data, "percent_change", "changesPercentage"));
  const up = (change ?? pct ?? 0) >= 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-foreground font-mono text-sm font-bold">{symbol}</span>
        {name && <span className="text-muted-foreground text-sm">{name}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {price != null && (
          <span className="text-foreground text-4xl font-semibold tabular-nums">{fmtNumber(price)}</span>
        )}
        {pct != null && (
          <Pill tone={up ? "up" : "down"}>
            {up ? "▲ Naik" : "▼ Turun"} {fmtPct(Math.abs(pct))}
          </Pill>
        )}
        {change != null && (
          <span className={`text-sm font-medium ${up ? "text-success" : "text-destructive"}`}>
            {up ? "+" : "−"}
            {fmtNumber(Math.abs(change))}
          </span>
        )}
      </div>
      <KeyValueView
        entries={[
          (() => {
            const prev = toNum(data.previous_close);
            return ["Penutupan sebelumnya", prev != null ? fmtNumber(prev) : null] as [string, ReactNode];
          })(),
          kvNum("Harga pembukaan", pick(data, "open")),
          kvNum("Tertinggi hari ini", pick(data, "day_high", "high")),
          kvNum("Terendah hari ini", pick(data, "day_low", "low")),
          kvNum("Volume", pick(data, "volume"), { notation: "compact" }),
          kvNum("Kapitalisasi pasar", pick(data, "market_cap", "marketCap"), { notation: "compact" }),
          [
            "Rentang 52 minggu",
            (() => {
              const lo = toNum(pick(data, "fifty_two_week_low", "fiftyTwoWeekLow"));
              const hi = toNum(pick(data, "fifty_two_week_high", "fiftyTwoWeekHigh"));
              return lo != null && hi != null ? `${fmtNumber(lo)} – ${fmtNumber(hi)}` : null;
            })(),
          ],
        ]}
      />
    </div>
  );
}

// ── financial-table ─────────────────────────────────────────────────────────

const PERIOD_KEYS = ["date", "endDate", "end_date", "asOfDate", "period", "fiscalDateEnding"];

/** get_balance_sheet / get_income_statement / get_cashflow → one table of
 *  periods × line items. */
export function FinancialTableView({ data }: { data: Record<string, unknown> }) {
  const statements = Array.isArray(data.statements) ? data.statements.filter(isRecord) : [];
  if (statements.length === 0) return null;
  const freq = pick<string>(data, "freq") === "annual" ? "tahunan" : "kuartalan";
  const columns = statements.map((s, i) => {
    const dateVal = PERIOD_KEYS.map((k) => pick<string>(s, k)).find(Boolean);
    return dateVal ?? `Periode ${i + 1}`;
  });
  const rows = new Set<string>();
  for (const s of statements) for (const k of Object.keys(s)) if (!PERIOD_KEYS.includes(k)) rows.add(k);
  const fmtCell = (v: unknown): string => {
    const n = toNum(v);
    return n != null ? fmtNumber(n, { notation: Math.abs(n) >= 10000 ? "compact" : "standard" }) : String(v ?? "—");
  };
  return (
    <div className="space-y-2">
      <SectionLabel>
        Laporan keuangan {pick<string>(data, "ticker", "symbol") ?? ""} · data {freq} · {statements.length} periode
      </SectionLabel>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="text-muted-foreground px-3 py-2 text-left font-medium">Pos</th>
              {columns.map((c) => (
                <th className="text-muted-foreground px-3 py-2 text-right font-medium" key={c}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...rows].map((k) => (
              <tr className="border-border/50 border-b last:border-b-0" key={k}>
                <td className="text-foreground px-3 py-1.5">{k}</td>
                {statements.map((s, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
                  <td className="text-foreground px-3 py-1.5 text-right tabular-nums" key={i}>
                    {fmtCell(s[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── social ──────────────────────────────────────────────────────────────────

/** trending_stocks → {"trending": [{symbol, title, watchers}]} */
export function TrendingView({ data }: { data: Record<string, unknown> }) {
  const trending = Array.isArray(data.trending) ? data.trending.filter(isRecord) : [];
  if (trending.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{trending.length} saham sedang tren</SectionLabel>
      <ol className="space-y-1.5">
        {trending.slice(0, 15).map((t, i) => {
          const watchers = toNum(pick(t, "watchers", "watchlist_count"));
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
            <li className="bg-card flex items-center gap-3 rounded-lg border px-3 py-2" key={i}>
              <span className="text-muted-foreground w-5 shrink-0 text-right font-mono text-xs">{i + 1}.</span>
              <span className="text-foreground font-mono text-sm font-bold">{pick<string>(t, "symbol") ?? "—"}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">{pick<string>(t, "title")}</span>
              {watchers != null && (
                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                  {fmtNumber(watchers)} pengamat
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const SENTIMENT_TONE: Record<string, "up" | "down" | "neutral"> = {
  bullish: "up",
  bearish: "down",
};

/** stock_social_feed → {"messages": [{user, body, sentiment, created_at, likes}]} */
export function SocialFeedView({ data }: { data: unknown }) {
  const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages.filter(isRecord) : [];
  if (messages.length === 0) return null;
  const symbol = isRecord(data) ? pick<string>(data, "symbol") : undefined;
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const m of messages) {
    const s = (pick<string>(m, "sentiment") ?? "neutral").toLowerCase();
    if (s in counts) counts[s as keyof typeof counts]++;
  }
  return (
    <div className="space-y-2">
      <SectionLabel>
        {symbol && <span className="font-mono">{symbol} · </span>}
        {messages.length} pos trader — {counts.bullish} bullish, {counts.bearish} bearish, {counts.neutral} netral
      </SectionLabel>
      <ul className="space-y-2">
        {messages.slice(0, 15).map((m, i) => {
          const sentiment = (pick<string>(m, "sentiment") ?? "neutral").toLowerCase();
          const body = pick<string>(m, "body", "text");
          const user = pick<string>(m, "user", "username");
          const date = fmtDate(pick(m, "created_at", "createdAt"));
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
            <li className="bg-card rounded-lg border p-3" key={i}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={SENTIMENT_TONE[sentiment] ?? "neutral"}>{sentiment}</Pill>
                <span className="text-foreground font-mono text-xs font-medium">{user ?? "anonim"}</span>
                {date && <span className="text-muted-foreground ml-auto font-mono text-[10px]">{date}</span>}
              </div>
              {body && <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{body}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── crypto ──────────────────────────────────────────────────────────────────

export function CryptoSearchView({ data }: { data: Record<string, unknown> }) {
  const coins = Array.isArray(data.coins) ? data.coins.filter(isRecord) : [];
  if (coins.length === 0) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  return (
    <RecordListView
      items={coins.slice(0, 12).map((c) => ({
        title: `${pick<string>(c, "name") ?? "?"} (${pick<string>(c, "symbol")?.toUpperCase() ?? "?"})`,
        body: `Rank #${toNum(pick(c, "market_cap_rank")) ?? "—"} · id: ${pick<string>(c, "id") ?? "—"}`,
        meta: pick<string>(c, "symbol"),
      }))}
    />
  );
}

export function CryptoMarketView({ data }: { data: unknown }) {
  const arr = Array.isArray(data)
    ? data.filter(isRecord)
    : isRecord(data) && Array.isArray((data as Record<string, unknown>).markets)
      ? ((data as Record<string, unknown>).markets as unknown[]).filter(isRecord)
      : [];
  if (arr.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{arr.length} koin — harga pasar</SectionLabel>
      <ul className="space-y-1.5">
        {arr.slice(0, 12).map((c, i) => {
          const name = pick<string>(c, "name") ?? pick<string>(c, "id") ?? `Coin ${i + 1}`;
          const sym = pick<string>(c, "symbol")?.toUpperCase();
          const price = toNum(pick(c, "current_price", "price", "usd"));
          const change = toNum(pick(c, "price_change_percentage_24h", "price_change_24h"));
          const mcap = toNum(pick(c, "market_cap"));
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: market results may legitimately contain duplicate ids
            <li key={i} className="bg-card rounded-lg border px-3 py-2 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm">
                  {name} {sym && <span className="text-muted-foreground font-mono text-xs">{sym}</span>}
                </div>
                <div className="text-muted-foreground text-xs">
                  {mcap != null ? `MCap ${fmtNumber(mcap, { notation: "compact" })}` : ""}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-semibold">{price != null ? `$${fmtNumber(price)}` : "—"}</div>
                {change != null && (
                  <div className={`text-xs ${change >= 0 ? "text-success" : "text-destructive"}`}>
                    {change >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(change))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── prediction-markets (get_prediction_markets — Polymarket) ────────────────

type PredictionMarket = {
  question: string;
  outcome: string;
  probability: number;
  volume: number;
  resolves: string;
  week_change_pp: number | null;
};

function parsePredictionMarkets(data: unknown): {
  topic: string;
  note: string;
  markets: PredictionMarket[];
  message: string;
} | null {
  if (!isRecord(data)) return null;
  const rawMarkets = data.markets;
  if (!Array.isArray(rawMarkets)) return null;
  const markets: PredictionMarket[] = [];
  for (const m of rawMarkets) {
    if (!isRecord(m)) continue;
    const probability = toNum(m.probability);
    const question = m.question;
    if (probability == null || typeof question !== "string") continue;
    const volume = toNum(m.volume);
    markets.push({
      question,
      outcome: typeof m.outcome === "string" ? m.outcome : "Yes",
      probability,
      volume: volume ?? 0,
      resolves: typeof m.resolves === "string" ? m.resolves : "",
      week_change_pp: toNum(m.week_change_pp),
    });
  }
  return {
    topic: typeof data.topic === "string" ? data.topic : "",
    note: typeof data.note === "string" ? data.note : "",
    markets,
    message: typeof data.message === "string" ? data.message : "",
  };
}

/** Crowd-odds bar color: conviction tiers (green ≥70, amber 30–70, red <30). */
function probTone(p: number): string {
  if (p >= 0.7) return "bg-success";
  if (p >= 0.3) return "bg-yellow-500";
  return "bg-destructive";
}

/** get_prediction_markets — Polymarket crowd-odds probability cards. */
export function PredictionMarketsView({ data }: { data: unknown }) {
  const parsed = parsePredictionMarkets(data);
  if (!parsed) return null; // legacy markdown / error strings → generic fallback

  if (parsed.markets.length === 0) {
    return (
      <div className="space-y-1.5">
        <SectionLabel>⚖️ Polymarket{parsed.topic ? ` — "${parsed.topic}"` : ""}</SectionLabel>
        <p className="text-muted-foreground text-sm">
          {parsed.message || "No open prediction markets matched."}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>
          ⚖️ Polymarket{parsed.topic ? ` — "${parsed.topic}"` : ""}
        </SectionLabel>
        <span className="text-muted-foreground text-[11px]">crowd odds</span>
      </div>
      <ul className="space-y-2">
        {parsed.markets.map((m, i) => {
          const pct = Math.round(m.probability * 100);
          return (
            <li
              className="bg-muted/40 space-y-1.5 rounded-lg border p-3"
              key={`${m.question}-${i}`}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm leading-snug font-medium">{m.question}</p>
                <div className="shrink-0 text-right">
                  <span className="font-mono text-base font-semibold tabular-nums">
                    {pct}%
                  </span>
                  <div className="text-muted-foreground text-[11px]">{m.outcome}</div>
                </div>
              </div>
              <div
                aria-label={`Probabilitas ${pct}%`}
                className="bg-background h-1.5 overflow-hidden rounded-full"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className={`h-full rounded-full ${probTone(m.probability)}`}
                  style={{ width: `${Math.min(100, Math.max(2, pct))}%` }}
                />
              </div>
              <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                {m.week_change_pp != null && (
                  <Pill tone={m.week_change_pp > 0 ? "up" : "down"}>
                    {m.week_change_pp > 0 ? "▲" : "▼"} {Math.abs(m.week_change_pp).toFixed(1)}pp
                    1w
                  </Pill>
                )}
                <span>${fmtNumber(m.volume, { notation: "compact" })} volume</span>
                {m.resolves && <span>· resolves {m.resolves}</span>}
              </div>
            </li>
          );
        })}
      </ul>
      {parsed.note && <p className="text-muted-foreground text-[11px] italic">{parsed.note}</p>}
    </div>
  );
}
