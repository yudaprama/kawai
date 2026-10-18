import type { ReactNode } from "react";

import { Icon } from "@/components/shared/icon";

import { Footnote, MetricGrid, TextCard, fmtNum, fmtPct, isRecord, num, parse, str, type Metric } from "./shared";

// ── helpers ────────────────────────────────────────────────────────────────

/** Accounting amounts arrive as exact decimal STRINGS (BigDecimal over
 * TEXT — never f64, so a 0.1 + 0.2 books exactly). Display them verbatim;
 * parsing them into a float here would reintroduce the drift the ledger
 * store exists to avoid. */
function dec(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  return s === "" ? undefined : s;
}

function row(v: unknown, key: string): string | undefined {
  return isRecord(v) ? dec(v[key]) : undefined;
}

/** A right-aligned monospace table cell. */
function Cell({ children, right }: { children: ReactNode; right?: boolean }) {
  return (
    <td className={`px-2 py-1 font-mono text-[11px] ${right ? "text-right tabular-nums" : ""}`}>
      {children}
    </td>
  );
}

function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <table className="w-full border-collapse">
      <thead>
        <tr className="border-border/60 border-b">
          {head.map((h, i) => (
            <th
              key={h}
              className={`text-muted-foreground px-2 py-1 text-left font-mono text-[10px] font-bold tracking-wider uppercase ${i > 0 ? "text-right" : ""}`}
            >
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

// ── binance_import_trades ───────────────────────────────────────────────────

/**
 * binance_import_trades →
 * { scanned, posted, skipped_already_imported, skipped_no_ledger_effect,
 *   pnl_total, fees_total, posted_ids: string[], posted_ids_truncated,
 *   wallet_account_id } — every amount an exact decimal string.
 *
 * The card's job is to prove the books were brought up to date and that
 * nothing was double-posted: posted vs skipped-already IS the idempotence
 * story, and the two skipped counters say why a scanned fill is not a
 * ledger entry (zero-effect fill, or one recorded in an earlier run).
 */
export function renderBinanceImportTrades(output: unknown): ReactNode {
  const d = parse(output);
  // The tool always emits `scanned`; without it this is not an import
  // payload (an error envelope, an empty object) and the raw JSON card
  // should stand instead of a card of zeros.
  if (!isRecord(d) || num(d.scanned) == null) return null;
  const scanned = num(d.scanned) ?? 0;
  const posted = num(d.posted) ?? 0;
  const skipped = num(d.skipped_already_imported) ?? 0;
  const empty = num(d.skipped_no_ledger_effect) ?? 0;
  const pnl = dec(d.pnl_total);
  const fees = dec(d.fees_total);
  const wallet = str(d.wallet_account_id);
  const postedIds = Array.isArray(d.posted_ids) ? d.posted_ids.filter((x): x is string => typeof x === "string") : [];
  const metrics: Metric[] = [
    { label: "Fills scanned", value: fmtNum(scanned) },
    {
      label: "Posted to ledger",
      value: fmtNum(posted),
      tone: posted > 0 ? "ok" : undefined,
    },
    { label: "Already recorded", value: fmtNum(skipped) },
  ];
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="database" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Ledger import
        </span>
        {wallet && <span className="text-muted-foreground font-mono text-[10px]">→ {wallet}</span>}
        {d.posted_ids_truncated === true && (
          <span className="border-warning/30 bg-warning/10 text-warning rounded-sm border px-1 py-px font-mono text-[10px] uppercase">
            list truncated
          </span>
        )}
      </div>
      <MetricGrid items={metrics} />
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span className="font-mono text-[11px]">
          realized PnL{" "}
          <span className={pnl?.startsWith("-") ? "text-destructive" : "text-success"}>{pnl ?? "—"}</span>
        </span>
        <span className="text-muted-foreground font-mono text-[11px]">
          fees <span className="text-foreground">{fees ?? "—"}</span>
        </span>
      </div>
      {empty > 0 && (
        <Footnote>
          {fmtNum(empty)} fill{empty === 1 ? "" : "s"} moved neither PnL nor commission — no ledger entry, by design.
        </Footnote>
      )}
      {postedIds.length > 0 && (
        <Footnote>
          Recorded as {postedIds.slice(0, 3).join(", ")}
          {postedIds.length > 3 ? ` +${postedIds.length - 3} more` : ""} — each exchange trade id posts exactly once.
        </Footnote>
      )}
    </TextCard>
  );
}

// ── crypto_futures_trade_stats ──────────────────────────────────────────────

/**
 * crypto_futures_trade_stats →
 * { market, statistics: { trades, wins, losses, breakevens, winRate, avgWin,
 *   avgLoss, expectancy, profitFactor, largestWin, totalRealizedPnl,
 *   settlementCurrency }, sync }.
 *
 * Round-trip statistics over the fills mirror (FIFO-matched): win rate is
 * breakevens-in-the-denominator by the crate's own convention, expectancy and
 * profit factor are the two numbers that decide whether the edge survives
 * fees, so they lead the grid.
 */
export function renderCryptoFuturesTradeStats(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const s = isRecord(d.statistics) ? d.statistics : null;
  if (!s) return null;
  const trades = num(s.trades) ?? 0;
  const wins = num(s.wins) ?? 0;
  const losses = num(s.losses) ?? 0;
  const breakevens = num(s.breakevens) ?? 0;
  const winRate = num(s.winRate);
  const expectancy = num(s.expectancy);
  const pf = num(s.profitFactor);
  const cur = str(s.settlementCurrency);
  const metrics: Metric[] = [
    { label: "Round trips", value: fmtNum(trades) },
    {
      label: "Win rate",
      value: winRate == null ? "—" : `${fmtPct(winRate * 100)}%`,
      sub: "breakevens in the denominator",
    },
    { label: "Expectancy", value: expectancy == null ? "—" : fmtNum(expectancy), tone: expectancy == null ? undefined : expectancy >= 0 ? "ok" : "danger" },
    { label: "Profit factor", value: pf == null ? "—" : fmtNum(pf), tone: pf == null ? undefined : pf >= 1 ? "ok" : "warn" },
    {
      label: "Realized PnL",
      value: str(s.totalRealizedPnl) ?? "—",
      tone: (str(s.totalRealizedPnl) ?? "").startsWith("-") ? "danger" : "ok",
    },
    { label: "Largest win", value: str(s.largestWin) ?? "—" },
  ];
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="chart-line" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Trade statistics
        </span>
        {str(d.market) && <span className="text-muted-foreground font-mono text-[10px]">{str(d.market)}</span>}
        {cur && <span className="text-muted-foreground font-mono text-[10px]">· settled in {cur}</span>}
      </div>
      <MetricGrid items={metrics} />
      <Footnote>
        {fmtNum(wins)} win · {fmtNum(losses)} loss{losses === 1 ? "" : "s"} · {fmtNum(breakevens)} breakeven{breakevens === 1 ? "" : "s"}
        {d.sync ? ` · ${str(d.sync)}` : ""}
      </Footnote>
    </TextCard>
  );
}

// ── trading_pnl_by_symbol ──────────────────────────────────────────────────

/**
 * trading_pnl_by_symbol →
 * { rows: [{ symbol, realized_pnl, commission, volume, fills }], totals: {…} }
 * — amounts are exact decimal strings, so the card prints them verbatim and
 * only the SIGN drives the tone. Rows arrive sorted by absolute contribution,
 * biggest mover first.
 */
export function renderTradingPnlBySymbol(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const rows = Array.isArray(d.rows) ? d.rows.filter(isRecord) : [];
  if (rows.length === 0) return null;
  const t = isRecord(d.totals) ? d.totals : null;
  const totalPnl = t ? dec(t.realized_pnl) : undefined;
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="chart-line" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Realized PnL by symbol
        </span>
        {totalPnl && (
          <span className={`font-mono text-[11px] ${totalPnl.startsWith("-") ? "text-destructive" : "text-success"}`}>
            net {totalPnl}
          </span>
        )}
      </div>
      <Table head={["symbol", "realized pnl", "commission", "volume", "fills"]}>
        {rows.map((r) => {
          const pnl = row(r, "realized_pnl");
          return (
            <tr key={str(r.symbol) ?? String(rows.indexOf(r))} className="border-border/40 border-b last:border-0">
              <Cell>{str(r.symbol) ?? "—"}</Cell>
              <Cell right>
                <span className={pnl?.startsWith("-") ? "text-destructive" : "text-success"}>{pnl ?? "—"}</span>
              </Cell>
              <Cell right>{row(r, "commission") ?? "—"}</Cell>
              <Cell right>{row(r, "volume") ?? "—"}</Cell>
              <Cell right>{fmtNum(num(r.fills) ?? 0)}</Cell>
            </tr>
          );
        })}
        {t && (
          <tr>
            <Cell>
              <span className="text-muted-foreground">total</span>
            </Cell>
            <Cell right>
              <span className={dec(t.realized_pnl)?.startsWith("-") ? "text-destructive" : "text-success"}>
                {dec(t.realized_pnl) ?? "—"}
              </span>
            </Cell>
            <Cell right>{dec(t.commission) ?? "—"}</Cell>
            <Cell right>{dec(t.volume) ?? "—"}</Cell>
            <Cell right>{fmtNum(num(t.fills) ?? 0)}</Cell>
          </tr>
        )}
      </Table>
      <Footnote>
        Exact decimals straight from the ledger — never rounded here.
      </Footnote>
    </TextCard>
  );
}

// ── trading_fee_summary ────────────────────────────────────────────────────

/**
 * trading_fee_summary →
 * { commission_total, volume_total, rows: [{ symbol, commission, volume }], fills }
 *
 * The fee-drag card: the ratio is the whole point of the workflow (a strategy
 * that earns less than it pays in fees), so the totals lead and the ratio is
 * shown as a share of volume computed from the printed strings — division on
 * display only, never written back.
 */
export function renderTradingFeeSummary(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const rows = Array.isArray(d.rows) ? d.rows.filter(isRecord) : [];
  const commission = dec(d.commission_total);
  const volume = dec(d.volume_total);
  const fills = num(d.fills) ?? 0;
  const ratio = ratioOf(commission, volume);
  const metrics: Metric[] = [
    { label: "Commission", value: commission ?? "—" },
    { label: "Volume", value: volume ?? "—" },
    { label: "Fee / volume", value: ratio ?? "—", tone: ratio != null && Number(ratio.replace("%", "")) > 1 ? "warn" : undefined },
  ];
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="calculator" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Fees
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">· {fmtNum(fills)} fills</span>
      </div>
      <MetricGrid items={metrics} />
      {rows.length > 0 && (
        <Table head={["symbol", "commission", "volume"]}>
          {rows.map((r, i) => (
            <tr key={str(r.symbol) ?? String(i)} className="border-border/40 border-b last:border-0">
              <Cell>{str(r.symbol) ?? "—"}</Cell>
              <Cell right>{row(r, "commission") ?? "—"}</Cell>
              <Cell right>{row(r, "volume") ?? "—"}</Cell>
            </tr>
          ))}
        </Table>
      )}
    </TextCard>
  );
}

/** commission ÷ volume as a display percentage, from decimal strings. */
function ratioOf(commission: string | undefined, volume: string | undefined): string | undefined {
  if (!commission || !volume) return undefined;
  const c = Number(commission);
  const v = Number(volume);
  if (!Number.isFinite(c) || !Number.isFinite(v) || v === 0) return undefined;
  return `${((c / v) * 100).toFixed(3)}%`;
}

// ── ledger_integrity_check ─────────────────────────────────────────────────

/**
 * ledger_integrity_check → { report, is_valid, issues }
 *
 * The gate of the close workflow: the balance sheet and trial balance must
 * balance. A pass is stated plainly; a fail lists the exact imbalance so the
 * reader does not have to open the database.
 */
export function renderLedgerIntegrityCheck(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const valid = d.is_valid === true;
  const issues = Array.isArray(d.issues) ? d.issues.filter((x): x is string => typeof x === "string") : [];
  const r = isRecord(d.report) ? d.report : {};
  const metrics: Metric[] = [
    { label: "Trial balance", value: dec(r.trial_balance_total_debits) ?? "—", sub: `credits ${dec(r.trial_balance_total_credits) ?? "—"}` },
    { label: "Assets", value: dec(r.balance_sheet_total_assets) ?? "—" },
    { label: "Liabilities + equity", value: dec(r.balance_sheet_total_liabilities_equity) ?? "—" },
  ];
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name={valid ? "shield-check" : "alert-triangle"} className={valid ? "text-success size-4" : "text-destructive size-4"} />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Ledger integrity
        </span>
        <span
          className={`rounded-sm border px-1 py-px font-mono text-[10px] uppercase ${valid ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"}`}
        >
          {valid ? "balanced" : "imbalanced"}
        </span>
        {str(r.as_of_date) && <span className="text-muted-foreground font-mono text-[10px]">as of {str(r.as_of_date)}</span>}
      </div>
      <MetricGrid items={metrics} />
      {!valid && issues.length > 0 && (
        <Footnote>
          {issues.map((issue) => (
            <div key={issue} className="text-destructive">
              {issue}
            </div>
          ))}
        </Footnote>
      )}
    </TextCard>
  );
}