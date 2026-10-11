import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { call, errText } from "@/lib/api";

import { fmtMoney, fmtPct, fmtPrice } from "@/components/ai-elements/tool-renderers/shared";
import { cn } from "@/lib/utils";

/** Dispatch key of the audit tool — identifies an audit run's step in both
 * live supervisor state and persisted run records. */
export const BINANCE_AUDIT_TOOL = "binance_futures_risk_audit";

/** The audit step of a run, if the run IS a futures risk audit. Accepts the
 * minimal step shape both the live supervisor state and the persisted run
 * records carry. */
export function auditRunStepId(steps: { tool: string; stepId: string }[] | undefined | null): string | null {
  const step = (steps ?? []).find((s) => s.tool === BINANCE_AUDIT_TOOL);
  return step?.stepId ?? null;
}

/** One position the stop action would protect: the engine's recommended
 * level + how far it sits. Listed only when the position carries NO resting
 * stop order — matching the batch's skip rule exactly. */
export interface OfferStopRow {
  symbol: string;
  long: boolean;
  size: number;
  mark: number;
  price: number;
  method: string;
  distancePct: number | null;
}

/** One position the take-profit action would cover: the fixed rungs (passed
 * windows dropped — their exit is gone) or the band exit. Listed only when
 * the position carries NO resting take-profit order. */
export interface OfferTpRow {
  symbol: string;
  long: boolean;
  size: number;
  mark: number;
  shape: string;
  rungs: { label: string; price: number; allocPct: number }[];
  bandExit: { method: string; price: number } | null;
}

/** One approval row: a position and exactly what a confirmed approval would
 * place for it (either side may be absent — a position that only lacks a
 * stop shows a stop, one lacking both shows both).
 *
 * `notional` is the comparable size (|positionAmt| × mark, the same figure the
 * backend ranks by) — raw coin counts are not comparable across symbols and
 * invert the risk order, since 0.002 BTC outranks 5,491 ZORA while reading as
 * the smallest number in the column. `riskReward` is the engine's reward:risk
 * for the stop+take-profit pair this row would place. */
export interface OfferRow {
  symbol: string;
  long: boolean;
  size: number;
  mark: number;
  notional: number;
  /** Null when the position has no both-sides R:R (one side absent). */
  riskReward: number | null;
  sl: { price: number; method: string; distancePct: number | null } | null;
  tp: OfferTpRow | null;
}

/** What the placement offer needs from the audit matrix: the portfolio
 * counts (`naked`/`noTp` — the whole book, graded or not), the echoed
 * `params` the actions re-run under, and the actionable approval rows with
 * the engine-computed levels. */
export interface AuditOffer {
  naked: number;
  noTp: number;
  params: { interval: string; risk: string; limit: number };
  stops: OfferStopRow[];
  tps: OfferTpRow[];
  rows: OfferRow[];
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

/** Parse the audit step's full output into the offer. The step body is the
 * tool's JSON emit: `summary` counts + echoed `params` + the per-position
 * `positions` matrix (coverage, resting-order counts, stop advice,
 * take-profit ladder). Rows that are not actionable are dropped: a stop row
 * needs a recommendation AND zero resting stops; a TP row needs un-passed
 * rungs or a band exit AND zero resting TPs — the same positions the
 * placement batches would actually touch. `rows` merges both sides per
 * symbol, in audit order (largest |notional| first). Anything unreadable →
 * null, and the offer renders nothing. */
export function parseAuditOffer(output: string | null | undefined): AuditOffer | null {
  if (output == null) return null;
  let v: unknown;
  try {
    v = JSON.parse(output);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v == null || !("summary" in v)) return null;
  const summary = v.summary;
  if (typeof summary !== "object" || summary == null) return null;
  if (!("naked" in summary) || !("usdmPositions" in summary) || !("withTakeProfit" in summary)) return null;
  const naked = num(summary.naked);
  const usdm = num(summary.usdmPositions);
  const withTp = num(summary.withTakeProfit);
  if (naked == null || usdm == null || withTp == null) return null;
  let interval = "4h";
  let risk = "standard";
  let limit = 25;
  if ("params" in v && typeof v.params === "object" && v.params != null) {
    const p = v.params;
    if ("interval" in p && typeof p.interval === "string") interval = p.interval;
    if ("risk" in p && typeof p.risk === "string") risk = p.risk;
    const parsedLimit = "limit" in p ? num(p.limit) : null;
    if (parsedLimit != null) limit = parsedLimit;
  }

  const stops: OfferStopRow[] = [];
  const tps: OfferTpRow[] = [];
  const meta = new Map<string, { notional: number; riskReward: number | null }>();
  if ("positions" in v && Array.isArray(v.positions)) {
    for (const row of v.positions) {
      if (typeof row !== "object" || row == null) continue;
      const symbol = str(row.symbol);
      if (symbol == null) continue;
      if (!("advice" in row) || typeof row.advice !== "object" || row.advice == null) continue;
      const a = row.advice;
      const amt = num(row.positionAmt);
      const long = amt != null ? amt > 0 : true;
      const size = amt != null ? Math.abs(amt) : 0;
      const mark = "markPrice" in row ? (num(row.markPrice) ?? 0) : 0;
      const restingStops = "restingStops" in row ? num(row.restingStops) : null;
      const restingTps = "restingTps" in row ? num(row.restingTps) : null;
      // Comparable size + the engine's R:R for this position. Kept in a
      // side map rather than on the stop/TP rows so the merged row shape stays
      // the reviewed contract.
      const notional = "notionalAbs" in row ? (num(row.notionalAbs) ?? Math.abs(size * mark)) : Math.abs(size * mark);
      const riskReward = "riskReward" in row ? num(row.riskReward) : null;
      meta.set(symbol, { notional, riskReward });

      if (restingStops === 0 && "recommended" in a && typeof a.recommended === "object" && a.recommended != null) {
        const rec = a.recommended;
        const price = "price" in rec ? num(rec.price) : null;
        const method = "method" in rec ? str(rec.method) : null;
        if (price != null && method != null) {
          stops.push({
            symbol,
            long,
            size,
            mark,
            price,
            method,
            distancePct: "distancePct" in rec ? num(rec.distancePct) : null,
          });
        }
      }

      if (restingTps === 0 && "takeProfit" in a && typeof a.takeProfit === "object" && a.takeProfit != null) {
        const tp = a.takeProfit;
        const shape = "shape" in tp ? str(tp.shape) : null;
        const rungs: OfferTpRow["rungs"] = [];
        if ("rungs" in tp && Array.isArray(tp.rungs)) {
          for (const r of tp.rungs) {
            if (typeof r !== "object" || r == null) continue;
            // A passed rung's exit window is gone — the batch never places
            // it, so the reviewed list must not show it.
            if ("passed" in r && r.passed === true) continue;
            const label = str(r.label);
            const price = num(r.price);
            const allocPct = num(r.allocPct);
            if (label != null && price != null && allocPct != null) rungs.push({ label, price, allocPct });
          }
        }
        const bandExit =
          "bandExit" in tp && typeof tp.bandExit === "object" && tp.bandExit != null && "price" in tp.bandExit
            ? { method: str(tp.bandExit.method) ?? "", price: num(tp.bandExit.price) ?? 0 }
            : null;
        if (shape != null && (rungs.length > 0 || bandExit != null)) {
          tps.push({ symbol, long, size, mark, shape, rungs, bandExit });
        }
      }
    }
  }

  // Merge the two sides per symbol, first-seen order (the audit's
  // largest-notional-first ordering).
  const bySymbol = new Map<string, OfferRow>();
  const touch = (symbol: string, long: boolean, size: number, mark: number): OfferRow => {
    let r = bySymbol.get(symbol);
    if (r == null) {
      const m = meta.get(symbol);
      r = {
        symbol,
        long,
        size,
        mark,
        notional: m?.notional ?? Math.abs(size * mark),
        riskReward: m?.riskReward ?? null,
        sl: null,
        tp: null,
      };
      bySymbol.set(symbol, r);
    }
    return r;
  };
  for (const s of stops)
    touch(s.symbol, s.long, s.size, s.mark).sl = { price: s.price, method: s.method, distancePct: s.distancePct };
  for (const t of tps) touch(t.symbol, t.long, t.size, t.mark).tp = t;

  return {
    naked,
    noTp: Math.max(0, usdm - withTp),
    params: { interval, risk, limit },
    stops,
    tps,
    rows: [...bySymbol.values()],
  };
}

/** Compact counts from a placement op's JSON result — the raw body stays
 * available in the failures disclosure. */
function placementSummary(raw: string): { placed: number; failed: number; note: string } | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v == null || !("protected" in v) || !("failed" in v)) return null;
  const placed = num(v.protected);
  const failed = num(v.failed);
  if (placed == null || failed == null) return null;
  const note = "note" in v ? str(v.note) : null;
  return { placed, failed, note: note ?? "" };
}

interface BinanceAuditOfferProps {
  /** Observability/session scope of the run whose audit is being offered on. */
  sessionId?: number | null;
  /** The audit run's plan key — scopes the full-output read. */
  planKey: string;
  /** The audit step's id (auditRunStepId). */
  stepId: string;
  /** Full-output fetcher — the same loader the canvas step reports use. */
  fetcher: (stepId: string, planKey?: string) => Promise<string | null>;
}

/** Post-audit placement offer: a table of the engine-computed levels the
 * user is being asked to approve. Selection granularity is the position —
 * approve one row, a subset via the checkboxes, or all — and every action
 * arms first: the confirmation click, nothing earlier, sends real orders.
 * Placement calls carry the approved symbol list, so the batch can never
 * widen the selection back to the whole book.
 *
 * This component never renders when there is nothing actionable, and a
 * failed matrix read renders nothing too — a broken read must not look like
 * "nothing to do". */
export function BinanceAuditOffer({ planKey, stepId, fetcher }: BinanceAuditOfferProps) {
  const [output, setOutput] = useState<string | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  /** Approval is OPT-IN: a 183-row whole-book placement is two clicks from
   * real reduce-only orders, so nothing is selected on arrival. "Select all"
   * has to be a deliberate act, not the resting state of the panel. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** "bulk" | `row:${symbol}` — only one arm at a time. */
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** One entry per executed approval, newest last. */
  const [log, setLog] = useState<{ id: number; label: string; raw?: string; error?: string }[]>([]);
  const logIdRef = useRef(0);

  useEffect(() => {
    let alive = true;
    setOutput(null);
    setReadFailed(false);
    setSelected(new Set());
    setArmedKey(null);
    void fetcher(stepId, planKey)
      .then((out) => {
        if (!alive) return;
        if (out == null) setReadFailed(true);
        else setOutput(out);
      })
      .catch(() => {
        if (alive) setReadFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [fetcher, planKey, stepId]);

  const offer = parseAuditOffer(output);
  if (readFailed || offer == null || offer.rows.length === 0) return null;

  const selectedRows = offer.rows.filter((r) => selected.has(r.symbol));
  const selectedStops = selectedRows.filter((r) => r.sl != null).length;
  const selectedTps = selectedRows.filter((r) => r.tp != null).length;
  const allSelected = selected.size === offer.rows.length;
  const noneSelected = selected.size === 0;
  // The scroll viewport is ~8 rows; the selection can be 183. Without this the
  // user arms a whole-book placement against a viewport showing 4% of it.
  const selectedNotional = selectedRows.reduce((sum, r) => sum + r.notional, 0);

  /** One approval = up to two op calls (stops, then TPs), each scoped to the
   * approved symbol list. Level cap 500 = the backend's AUDIT_LIMIT_MAX, so
   * an approved whole-book selection is never silently truncated. */
  const executeRows = async (label: string, rows: OfferRow[]) => {
    if (busy || rows.length === 0) return;
    setBusy(true);
    setArmedKey(null);
    const slSymbols = rows.filter((r) => r.sl != null).map((r) => r.symbol);
    const tpSymbols = rows.filter((r) => r.tp != null).map((r) => r.symbol);
    const p = offer.params;
    try {
      const out: string[] = [];
      if (slSymbols.length > 0) {
        out.push(
          await call<string>("binance_auto_protect_positions", {
            interval: p.interval,
            risk: p.risk,
            limit: 500,
            symbols: slSymbols,
          }),
        );
      }
      if (tpSymbols.length > 0) {
        out.push(
          await call<string>("binance_auto_take_profit_positions", {
            interval: p.interval,
            style: "standard",
            limit: 500,
            symbols: tpSymbols,
          }),
        );
      }
      const id = ++logIdRef.current;
      setLog((l) => [...l, { id, label, raw: out.join("\n\n") }]);
    } catch (e) {
      const id = ++logIdRef.current;
      setLog((l) => [...l, { id, label, error: errText(e) }]);
    } finally {
      setBusy(false);
    }
  };

  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(offer.rows.map((r) => r.symbol)));
  const toggleRow = (symbol: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(symbol)) next.delete(symbol);
      else next.add(symbol);
      return next;
    });

  const side = (long: boolean) => (long ? "long" : "short");
  // Engine vocabulary is snake_case (band_exit, chandelier_exit, keltner_10_2);
  // it reads as an identifier leaking into the UI, so it is spaced out here.
  const human = (method: string) => method.replace(/_/g, " ");
  const tpCell = (tp: OfferRow["tp"]) => {
    if (tp == null) return <span className="text-muted-foreground/50">—</span>;
    return (
      <span className="flex flex-col gap-0.5">
        <span>{tp.rungs.map((g) => `${g.label} ${fmtPrice(g.price)} (${fmtPct(g.allocPct)}%)`).join(" · ")}</span>
        {tp.bandExit != null && (
          <span className="text-muted-foreground/80">
            band exit {fmtPrice(tp.bandExit.price)}
            {tp.bandExit.method ? ` · ${human(tp.bandExit.method)}` : ""}
          </span>
        )}
      </span>
    );
  };

  return (
    <div className="border-primary/30 bg-card space-y-3 rounded-lg border p-4">
      <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs font-bold tracking-wider uppercase">
        <Icon name="shield-check" className="text-primary size-4" />
        Protect this book
      </div>
      {/* Four lines of mono prose explained what four chips say faster. */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        <span className="rounded border px-1.5 py-0.5">{offer.params.interval} candles</span>
        <span className="rounded border px-1.5 py-0.5">{offer.params.risk} stops</span>
        <span className="rounded border px-1.5 py-0.5">standard take-profit</span>
        <span className="text-destructive rounded border px-1.5 py-0.5">{offer.naked} without a stop</span>
        <span className="rounded border px-1.5 py-0.5">{offer.noTp} without a take-profit</span>
      </div>
      <p className="text-muted-foreground text-xs">
        Approve the rows you want protected — one, a subset, or all.
        {offer.naked > offer.stops.length &&
          ` This audit graded only the ${offer.params.limit} largest, so ${offer.naked - offer.stops.length} smaller unprotected positions are not listed; re-run with "Positions graded: All" to cover the whole book.`}
      </p>

      <div className="space-y-1.5">
        <div className="border-border/60 max-h-96 overflow-y-auto rounded-md border">
          <table className="w-full border-collapse font-mono text-[11px]">
            <thead className="bg-background sticky top-0 z-10">
              <tr className="text-muted-foreground border-border/60 border-b text-left">
                <th className="p-1.5">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleAll}
                    disabled={busy}
                    aria-label="Select all positions"
                    className="accent-primary"
                  />
                </th>
                <th className="p-1.5">Symbol</th>
                <th className="p-1.5">Side</th>
                {/* Notional, not coin count: 0.002 BTC and 5,491 ZORA are not
                    comparable, and the raw counts inverted the risk order the
                    backend actually ranked by. */}
                <th className="p-1.5 text-right">Notional</th>
                <th className="p-1.5 text-right">Mark</th>
                <th className="p-1.5">Recommended stop</th>
                <th className="p-1.5">Recommended take-profit</th>
                <th className="p-1.5 text-right" title="Reward-to-risk of the stop and first take-profit together">
                  R:R
                </th>
                <th className="p-1.5" aria-label="Approve row" />
              </tr>
            </thead>
            <tbody>
              {offer.rows.map((r) => {
                const rowKey = `row:${r.symbol}`;
                return (
                  <tr
                    key={r.symbol}
                    className={cn(
                      "border-border/40 hover:bg-muted/20 border-b last:border-b-0",
                      selected.has(r.symbol) && "bg-primary/5",
                    )}
                  >
                    <td className="p-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(r.symbol)}
                        onChange={() => toggleRow(r.symbol)}
                        disabled={busy}
                        aria-label={`Select ${r.symbol}`}
                        className="accent-primary"
                      />
                    </td>
                    <td className="text-foreground p-1.5">{r.symbol}</td>
                    <td className="text-muted-foreground p-1.5">{side(r.long)}</td>
                    <td className="text-foreground p-1.5 text-right tabular-nums">{fmtMoney(r.notional)}</td>
                    {/* A null `sl` means either "a stop already rests" or "the
                        engine found no valid level" — assert the fact that
                        holds for both rather than guessing the reason. */}
                    <td className="p-1.5">
                      {r.sl != null ? (
                        <>
                          <span className="text-foreground">{fmtPrice(r.sl.price)}</span>{" "}
                          <span className="text-muted-foreground">
                            · {human(r.sl.method)}
                            {r.sl.distancePct != null && ` (${fmtPct(r.sl.distancePct)}%)`}
                          </span>
                        </>
                      ) : (
                        <span className="text-muted-foreground/50 text-[10px]">no stop to place</span>
                      )}
                    </td>
                    <td className="p-1.5">{tpCell(r.tp)}</td>
                    <td className="text-muted-foreground p-1.5 text-right tabular-nums">
                      {r.riskReward != null ? `${fmtPct(r.riskReward)}R` : "—"}
                    </td>
                    <td className="p-1.5 text-right whitespace-nowrap">
                      {armedKey === rowKey ? (
                        <span className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => void executeRows(r.symbol, [r])}
                            className="bg-primary text-primary-foreground rounded px-1.5 py-0.5 font-bold uppercase"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => setArmedKey(null)}
                            className="border-border text-muted-foreground rounded border px-1.5 py-0.5 uppercase"
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => setArmedKey(rowKey)}
                          className="border-border text-muted-foreground hover:border-[var(--tea-color-border-focus)] hover:text-foreground rounded border px-1.5 py-0.5 uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          Approve
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {/* The viewport is ~8 rows tall; a whole-book selection is not. The
            count and the exposure stay on screen so the armed action can never
            describe orders the user cannot see. */}
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
          <span>
            {noneSelected
              ? `Nothing selected — ${offer.rows.length} position${offer.rows.length === 1 ? "" : "s"} available`
              : `${selectedRows.length} of ${offer.rows.length} selected`}
          </span>
          {!noneSelected && <span className="text-foreground">{fmtMoney(selectedNotional)} exposure</span>}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!allSelected && !noneSelected && !busy && (
          <Button onClick={toggleAll} size="sm" variant="outline">
            Select all {offer.rows.length}
          </Button>
        )}
        {armedKey === "bulk" ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-foreground font-mono text-[11px]">
              Place {selectedStops} stop{selectedStops === 1 ? "" : "s"} and {selectedTps} take-profit
              {selectedTps === 1 ? "" : "s"} on {selectedRows.length} position
              {selectedRows.length === 1 ? "" : "s"} ({fmtMoney(selectedNotional)} exposure)?
            </span>
            <Button disabled={busy} onClick={() => void executeRows("selected", selectedRows)} size="sm">
              Confirm
            </Button>
            <Button disabled={busy} onClick={() => setArmedKey(null)} size="sm" variant="outline">
              Cancel
            </Button>
          </span>
        ) : (
          <Button disabled={busy || selectedRows.length === 0} onClick={() => setArmedKey("bulk")} size="sm">
            {busy ? (
              <Icon name="loader-circle" className="size-3 animate-spin" />
            ) : (
              <Icon name="shield-alert" className="size-3" />
            )}
            {/* The consequence belongs on the FIRST click, not only on the
                arm step — a button reading "Approve selected (183)" told the
                user nothing about what 183 meant. */}
            {selectedRows.length === 0
              ? "Select positions to approve"
              : `Place ${selectedStops} stop${selectedStops === 1 ? "" : "s"} + ${selectedTps} take-profit${selectedTps === 1 ? "" : "s"}`}
          </Button>
        )}
      </div>

      {log.map((entry) => (
        <div key={entry.id} className="space-y-0.5">
          <div className="text-muted-foreground font-mono text-[10px] tracking-wider uppercase">
            {entry.label === "selected" ? "Selected rows" : entry.label}
          </div>
          {entry.error != null ? (
            <span className="text-destructive block font-mono text-[11px]" role="alert">
              {entry.error}
            </span>
          ) : (
            <PlacementResult raw={entry.raw ?? ""} />
          )}
        </div>
      ))}

      {/* The safety guarantee was 10px prose below the fold — the most
          important text on a panel that places real orders. Promoted to a
          readable line; the rate limit only matters while a run is in
          flight, so it appears then instead of permanently. */}
      <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
        <Icon name="shield-check" className="text-success mt-0.5 size-3.5 shrink-0" />
        <span>
          Reduce-only: these orders can only close positions, never open or increase one. Levels come from the same
          engine that graded this report and are re-validated against live prices at placement.
          {busy && " Running at up to 120 orders/minute — a large book takes a few minutes."}
        </span>
      </p>
    </div>
  );
}

/** A placement result: compact counts up front, per-order failures in a
 * disclosure (one bad symbol never hides the rest), and the re-audit hint —
 * the verdicts above are from report time. */
function PlacementResult({ raw }: { raw: string }) {
  const parts = raw.split("\n\n").filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return (
    <span className="w-full space-y-1">
      {parts.map((part) => {
        const summary = placementSummary(part);
        if (summary == null) {
          return (
            <pre
              key={part.slice(0, 32)}
              className="text-muted-foreground overflow-x-auto font-mono text-[10px] leading-relaxed"
            >
              {part}
            </pre>
          );
        }
        return (
          <span
            key={part.slice(0, 32)}
            className="text-foreground flex flex-wrap items-center gap-1.5 font-mono text-[11px]"
          >
            <Icon name="check" className="text-success size-3" />
            {summary.placed} order{summary.placed === 1 ? "" : "s"} placed
            {summary.failed > 0 && <span className="text-destructive">· {summary.failed} failed</span>}
            {summary.placed + summary.failed > 0 && (
              <span className="text-muted-foreground">— re-run the audit to refresh the verdicts</span>
            )}
            {summary.note != null && summary.note.length > 0 && (
              <span className="text-muted-foreground block font-mono text-[10px] leading-relaxed">{summary.note}</span>
            )}
          </span>
        );
      })}
    </span>
  );
}
