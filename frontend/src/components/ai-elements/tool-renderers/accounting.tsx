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
// ── ledger reports (the close workflow's four statements) ───────────────────

/** Every report tool wraps the engine's DTO: `{ report: {...} }`. Amounts
 * inside are exact decimal strings; `as_of_date` / period dates are the
 * engine's own `YYYY-MM-DD`. */
function report(output: unknown): Record<string, unknown> | null {
  const d = parse(output);
  if (!isRecord(d)) return null;
  return isRecord(d.report) ? d.report : null;
}

/** AccountBalance → one table row: account name, debit, credit. */
function balanceRows(list: unknown): { label: string; debit?: string; credit?: string }[] {
  if (!Array.isArray(list)) return [];
  return list.filter(isRecord).map((b) => {
    const account = isRecord(b.account) ? b.account : null;
    return {
      label: (account && str(account.name)) || (account && str(account.id)) || str(b.account_id) || "account",
      debit: dec(b.debit_balance),
      credit: dec(b.credit_balance),
    };
  });
}

/** A debit/credit two-column table — the shape of every balance report. */
function LedgerTable({
  groups,
}: {
  groups: { label: string; rows: { label: string; debit?: string; credit?: string }[] }[];
}) {
  return (
    <>
      {groups.map((g) =>
        g.rows.length === 0 ? null : (
          <div key={g.label}>
            <div className="text-muted-foreground mb-1 font-mono text-[10px] font-bold tracking-wider uppercase">
              {g.label}
            </div>
            <Table head={["account", "debit", "credit"]}>
              {g.rows.map((r, i) => (
                <tr key={`${g.label}-${r.label}-${i}`} className="border-border/40 border-b last:border-0">
                  <Cell>{r.label}</Cell>
                  <Cell right>{r.debit ?? ""}</Cell>
                  <Cell right>{r.credit ?? ""}</Cell>
                </tr>
              ))}
            </Table>
          </div>
        ),
      )}
    </>
  );
}

/** ledger_trial_balance → { report: { as_of_date, balances: {id: AccountBalance},
 *   total_debits, total_credits, is_balanced } }.
 *
 * `balances` is a MAP keyed by account id, so the renderer flattens it into
 * sorted rows — a JSON object would otherwise be a wall of braces. */
export function renderLedgerTrialBalance(output: unknown): ReactNode {
  const r = report(output);
  if (!r) return null;
  const balances = isRecord(r.balances) ? r.balances : null;
  if (!balances) return null;
  const rows = Object.entries(balances)
    .map(([id, b]) => {
      const account = isRecord(b) && isRecord(b.account) ? b.account : null;
      return {
        label: (account && str(account.name)) || id,
        debit: isRecord(b) ? dec(b.debit_balance) : undefined,
        credit: isRecord(b) ? dec(b.credit_balance) : undefined,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const balanced = r.is_balanced === true;
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="scale" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Trial balance
        </span>
        {str(r.as_of_date) && (
          <span className="text-muted-foreground font-mono text-[10px]">as of {str(r.as_of_date)}</span>
        )}
        <span
          className={`rounded-sm border px-1 py-px font-mono text-[10px] uppercase ${balanced ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"}`}
        >
          {balanced ? "balanced" : "out of balance"}
        </span>
      </div>
      <LedgerTable groups={[{ label: "accounts", rows }]} />
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
        <span>
          total debits <span className="text-foreground">{dec(r.total_debits) ?? "—"}</span>
        </span>
        <span>
          total credits <span className="text-foreground">{dec(r.total_credits) ?? "—"}</span>
        </span>
      </div>
    </TextCard>
  );
}

/** ledger_balance_sheet → { report: { as_of_date, assets, liabilities, equity,
 *   total_assets, total_liabilities, total_equity, is_balanced } }.
 *
 * Equity carries the engine's synthetic `net_income` line when it is
 * non-zero — that row is the period's result folded into the sheet, so it
 * is rendered like any other equity row rather than hidden. */
export function renderLedgerBalanceSheet(output: unknown): ReactNode {
  const r = report(output);
  if (!r || r.assets === undefined) return null;
  const balanced = r.is_balanced === true;
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="landmark" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Balance sheet
        </span>
        {str(r.as_of_date) && (
          <span className="text-muted-foreground font-mono text-[10px]">as of {str(r.as_of_date)}</span>
        )}
        <span
          className={`rounded-sm border px-1 py-px font-mono text-[10px] uppercase ${balanced ? "border-success/30 bg-success/10 text-success" : "border-destructive/30 bg-destructive/10 text-destructive"}`}
        >
          {balanced ? "balanced" : "out of balance"}
        </span>
      </div>
      <LedgerTable
        groups={[
          { label: "assets", rows: balanceRows(r.assets) },
          { label: "liabilities", rows: balanceRows(r.liabilities) },
          { label: "equity", rows: balanceRows(r.equity) },
        ]}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px]">
        <span>
          assets <span className="text-foreground">{dec(r.total_assets) ?? "—"}</span>
        </span>
        <span>
          liabilities <span className="text-foreground">{dec(r.total_liabilities) ?? "—"}</span>
        </span>
        <span>
          equity <span className="text-foreground">{dec(r.total_equity) ?? "—"}</span>
        </span>
      </div>
    </TextCard>
  );
}

/** ledger_income_statement → { report: { start_date, end_date, revenue,
 *   expenses, total_revenue, total_expenses, net_income } }.
 *
 * Net income is the number the whole report exists for, so it leads as a
 * metric (coloured by sign) and the two columns follow. */
export function renderLedgerIncomeStatement(output: unknown): ReactNode {
  const r = report(output);
  if (!r || r.revenue === undefined) return null;
  const net = dec(r.net_income);
  const period =
    str(r.start_date) && str(r.end_date) ? `${str(r.start_date)} → ${str(r.end_date)}` : str(r.end_date);
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="trending-up" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Income statement
        </span>
        {period && <span className="text-muted-foreground font-mono text-[10px]">{period}</span>}
      </div>
      <MetricGrid
        items={[
          { label: "Revenue", value: dec(r.total_revenue) ?? "—" },
          { label: "Expenses", value: dec(r.total_expenses) ?? "—" },
          {
            label: "Net income",
            value: net ?? "—",
            tone: net?.startsWith("-") ? "danger" : "ok",
          },
        ]}
      />
      <LedgerTable
        groups={[
          { label: "revenue", rows: balanceRows(r.revenue) },
          { label: "expenses", rows: balanceRows(r.expenses) },
        ]}
      />
    </TextCard>
  );
}

/** ledger_cash_flow → { report: { start_date, end_date, operating_activities,
 *   investing_activities, financing_activities, net_operating_cash_flow,
 *   net_investing_cash_flow, net_financing_cash_flow, … } } with
 * `CashFlowItem { description, amount }` rows.
 *
 * The three nets are the summary; each activity list is a
 * description/amount pair rather than accounts, so it gets its own table. */
export function renderLedgerCashFlow(output: unknown): ReactNode {
  const r = report(output);
  if (!r || r.operating_activities === undefined) return null;
  const items = (list: unknown) =>
    (Array.isArray(list) ? list.filter(isRecord) : []).map((i) => ({
      label: str(i.description) ?? "—",
      amount: dec(i.amount) ?? "—",
      negative: (dec(i.amount) ?? "").startsWith("-"),
    }));
  const nets: Metric[] = [
    { label: "Operating", value: dec(r.net_operating_cash_flow) ?? "—", tone: (dec(r.net_operating_cash_flow) ?? "").startsWith("-") ? "danger" : "ok" },
    { label: "Investing", value: dec(r.net_investing_cash_flow) ?? "—" },
    { label: "Financing", value: dec(r.net_financing_cash_flow) ?? "—" },
  ];
  const period =
    str(r.start_date) && str(r.end_date) ? `${str(r.start_date)} → ${str(r.end_date)}` : str(r.end_date);
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="waves" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Cash flow
        </span>
        {period && <span className="text-muted-foreground font-mono text-[10px]">{period}</span>}
      </div>
      <MetricGrid items={nets} />
      {(
        [
          ["operating", r.operating_activities],
          ["investing", r.investing_activities],
          ["financing", r.financing_activities],
        ] as [string, unknown][]
      ).map(([label, list]) => {
        const rows = items(list);
        return rows.length === 0 ? null : (
          <div key={label}>
            <div className="text-muted-foreground mb-1 font-mono text-[10px] font-bold tracking-wider uppercase">
              {label}
            </div>
            <Table head={["item", "amount"]}>
              {rows.map((row, i) => (
                <tr key={`${label}-${i}`} className="border-border/40 border-b last:border-0">
                  <Cell>{row.label}</Cell>
                  <Cell right>
                    <span className={row.negative ? "text-destructive" : "text-foreground"}>{row.amount}</span>
                  </Cell>
                </tr>
              ))}
            </Table>
          </div>
        );
      })}
    </TextCard>
  );
}

// ── ledger_list_transactions ───────────────────────────────────────────────

/** ledger_list_transactions → { count, items: Transaction[], pagination? }
 * where `Transaction` carries `{ id, date, description, reference, entries }`
 * and each `Entry` is `{ account_id, entry_type, amount }`.
 *
 * The ledger's transaction log is the raw journal: one row per transaction
 * with its legs collapsed into "debit a → credit b" so the double-entry
 * shape stays visible without a wall of JSON. */
export function renderLedgerListTransactions(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const items = Array.isArray(d.items) ? d.items.filter(isRecord) : [];
  if (items.length === 0) return null;
  const pagination = isRecord(d.pagination) ? d.pagination : null;
  const page = pagination ? num(pagination.page) : null;
  const totalPages = pagination ? num(pagination.total_pages) : null;
  const legs = (t: Record<string, unknown>) =>
    (Array.isArray(t.entries) ? t.entries.filter(isRecord) : [])
      .map((e) => {
        const account = str(e.account_id) ?? "?";
        const type = str(e.entry_type) ?? "";
        const amount = dec(e.amount) ?? "";
        return `${type === "debit" ? "D" : "C"} ${account} ${amount}`;
      })
      .join("  ·  ");
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="list" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Transactions
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">
          {fmtNum(num(d.count) ?? items.length)} row{items.length === 1 ? "" : "s"}
          {totalPages != null ? ` · page ${page ?? "?"} of ${totalPages}` : ""}
        </span>
      </div>
      <Table head={["date", "description", "legs"]}>
        {items.map((t, i) => (
          <tr key={str(t.id) ?? String(i)} className="border-border/40 border-b last:border-0">
            <Cell>{str(t.date) ?? "—"}</Cell>
            <Cell>{str(t.description) ?? "—"}</Cell>
            <Cell right>
              <span className="text-muted-foreground">{legs(t)}</span>
            </Cell>
          </tr>
        ))}
      </Table>
    </TextCard>
  );
}

// ── invoice_list ───────────────────────────────────────────────────────────

/** invoice_list → { count, items: [{ invoice_number, issue_date, buyer,
 *   taxable_value, cgst, sgst, igst, total }] } — the GST layer, dormant
 * under the trading-books wedge but rendered here so the tool is never a
 * bare JSON dump. */
export function renderInvoiceList(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d)) return null;
  const items = Array.isArray(d.items) ? d.items.filter(isRecord) : [];
  if (items.length === 0) return null;
  return (
    <TextCard>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Icon name="receipt" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">
          Invoices
        </span>
        <span className="text-muted-foreground font-mono text-[10px]">
          {fmtNum(num(d.count) ?? items.length)}
        </span>
      </div>
      <Table head={["number", "date", "taxable", "cgst", "sgst", "igst", "total"]}>
        {items.map((inv, i) => (
          <tr key={str(inv.invoice_number) ?? String(i)} className="border-border/40 border-b last:border-0">
            <Cell>{str(inv.invoice_number) ?? "—"}</Cell>
            <Cell>{str(inv.issue_date) ?? "—"}</Cell>
            <Cell right>{dec(inv.taxable_value) ?? "—"}</Cell>
            <Cell right>{dec(inv.cgst) ?? ""}</Cell>
            <Cell right>{dec(inv.sgst) ?? ""}</Cell>
            <Cell right>{dec(inv.igst) ?? ""}</Cell>
            <Cell right>
              <span className="text-foreground">{dec(inv.total) ?? "—"}</span>
            </Cell>
          </tr>
        ))}
      </Table>
    </TextCard>
  );
}
