import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { call, errText } from "@/lib/api";

import {
  fmtMoney,
  fmtPct,
  fmtPrice,
  fmtRR,
  fmtSigned,
  placedRR,
  TpLadder,
} from "@/components/ai-elements/tool-renderers/shared";
import { cn } from "@/lib/utils";

import { MatchCount, SelectMatchingButton, SymbolSearch } from "./workbench-ui";

/** Which exchange's book an audit graded. The risk POLICY is venue-neutral
 * (`kawai_futures_risk`), but the placement ops are per-venue — MEXC keeps
 * conditional orders outside the resting order book and has no stop-move
 * batch yet — so the offer has to know whose orders it would place. */
export type AuditVenue = "binance" | "mexc";

/** Exchange label for the offer's chips. */
const VENUE_LABEL: Record<AuditVenue, string> = { binance: "Binance", mexc: "MEXC" };

/** Dispatch keys of the audit tools — identify an audit run's step in both
 * live supervisor state and persisted run records. */
export const AUDIT_TOOLS: Record<AuditVenue, string> = {
  binance: "binance_futures_risk_audit",
  mexc: "mexc_futures_risk_audit",
};

/** The placement op each action calls, per venue. `tighten` is absent for
 * MEXC: there is no move batch, so the offer never lists a resting stop to
 * move there (and this type makes that impossible to forget). */
const PLACEMENT_OPS: Record<AuditVenue, { protect: string; takeProfit: string; tighten: string | null }> = {
  binance: {
    protect: "binance_auto_protect_positions",
    takeProfit: "binance_auto_take_profit_positions",
    tighten: "binance_auto_tighten_stops",
  },
  mexc: {
    protect: "mexc_auto_protect_positions",
    takeProfit: "mexc_auto_take_profit_positions",
    tighten: null,
  },
};

/** The audit step of a run, if the run IS a futures risk audit — the step id
 * (the offer's output key) plus the venue whose orders it would place.
 * Accepts the minimal step shape both the live supervisor state and the
 * persisted run records carry. */
export function auditRunStep(
  steps: { tool: string; stepId: string }[] | undefined | null,
): { stepId: string; venue: AuditVenue } | null {
  const list = steps ?? [];
  for (const [venue, tool] of Object.entries(AUDIT_TOOLS) as [AuditVenue, string][]) {
    const step = list.find((s) => s.tool === tool);
    if (step != null) return { stepId: step.stepId, venue };
  }
  return null;
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
 * windows dropped — their exit is gone), the band exit, and the trailing exit.
 * The trailing leg matters most on a `ladder_runner` shape — it IS the runner
 * the ladder defers to — and the parser used to drop it, so the approval table
 * under-reported what a confirmed approval would actually place.
 * Listed only when the position carries NO resting take-profit order. */
export interface OfferTpRow {
  symbol: string;
  long: boolean;
  size: number;
  mark: number;
  shape: string;
  rungs: { label: string; price: number; allocPct: number }[];
  bandExit: { method: string; price: number } | null;
  trailingExit: { method: string; price: number } | null;
}

/** One position whose RESTING stop the engine graded `tighten`: where the
 * stop sits now and the level it would move to. This is the population the
 * stop-move action touches — positions already protected, where a lock-in at
 * break-even has become valid (profit past 1×ATR). Distinct from
 * {@link OfferStopRow}, which lists positions carrying NO stop at all. */
export interface OfferTightenRow {
  symbol: string;
  long: boolean;
  size: number;
  mark: number;
  from: number;
  to: number;
  method: string;
}

/** One approval row: a position and exactly what a confirmed approval would
 * place for it (either side may be absent — a position that only lacks a
 * stop shows a stop, one lacking both shows both).
 *
 * `notional` is the comparable size (|positionAmt| × mark, the same figure the
 * backend ranks by) — raw coin counts are not comparable across symbols and
 * invert the risk order, since 0.002 BTC outranks 5,491 ZORA while reading as
 * the smallest number in the column. `entry` is the anchor an R-multiple is
 * measured from. `riskReward` is the engine's resting-pair grade, kept for
 * reference; the R:R column derives its own figure from what a placement
 * would create. */
export interface OfferRow {
  symbol: string;
  entry: number;
  long: boolean;
  size: number;
  mark: number;
  notional: number;
  /** Exchange's own unrealized P&L at mark — direction-correct for both
   * sides, and the figure the "hanya posisi untung" scope filters on. */
  pnl: number;
  /** Null when the position has no both-sides R:R (one side absent). */
  riskReward: number | null;
  sl: { price: number; method: string; distancePct: number | null } | null;
  tp: OfferTpRow | null;
  /** Present when a resting stop exists AND the engine graded it `tighten` —
   * the level that stop would move TO, and where it rests now. Excludes the
   * positions with no stop at all (`sl`), which the protect action places. */
  tighten: { from: number; to: number; method: string } | null;
  /** The resting stop already sits at/beyond entry: the trade cannot turn
   * into a loss and advice never rolls it back. Its verdict is `ok`, the same
   * as a stop that merely happens to align, so without this flag the row would
   * read as "already tight" and the operator could not tell that the only
   * remaining move here is to TRAIL it — never to loosen it. */
  locked: boolean;
}

/** What the placement offer needs from the audit matrix: the portfolio
 * counts (`naked`/`noTp` — the whole book, graded or not), the echoed
 * `params` the actions re-run under, and the actionable approval rows with
 * the engine-computed levels. */
export interface AuditOffer {
  naked: number;
  noTp: number;
  params: { interval: string; risk: string; limit: number };
  tightens: OfferTightenRow[];
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
 * placement batches would actually touch, plus the `tighten` verdicts — a
 * position that already has a stop but where the engine wants it tighter
 * (the break-even lock becomes valid once profit passes 1×ATR). `rows`
 * merges all three sides per symbol, in audit order (largest |notional|
 * first). Anything unreadable → null, and the offer renders nothing. */
export function parseAuditOffer(output: string | null | undefined, venue: AuditVenue = "binance"): AuditOffer | null {
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
  // Whole-book counts. Both audits report the same facts, in their own block:
  // Binance flattens them into `summary` (book size `usdmPositions` — it also
  // carries COIN-M), MEXC keeps them in `coverage` (book size `positions` — one
  // futures family). The offer reads the block the venue actually emits rather
  // than trusting one spelling everywhere.
  const counts: Record<string, unknown> | null =
    venue === "mexc"
      ? "coverage" in v && typeof v.coverage === "object" && v.coverage != null
        ? (v.coverage as Record<string, unknown>)
        : null
      : "naked" in summary && "withTakeProfit" in summary
        ? (summary as Record<string, unknown>)
        : null;
  if (counts == null) return null;
  const naked = num(counts.naked);
  const usdm = num(counts.usdmPositions ?? counts.positions);
  const withTp = num(counts.withTakeProfit);
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
  const tightens: OfferTightenRow[] = [];
  const meta = new Map<string, { notional: number; riskReward: number | null; entry: number; pnl: number }>();
  // Positions whose resting stop is already at/beyond entry. They are NOT
  // actionable (no stop to place, nothing to tighten, and advice never rolls a
  // locked stop back), so no side list claims them — but they must still reach
  // the table, or the operator sees an empty cell where the one decision that
  // remains — trail it — actually lies.
  const locked: { symbol: string; long: boolean; size: number; mark: number }[] = [];
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
      const entry = "entryPrice" in row ? (num(row.entryPrice) ?? 0) : 0;
      // The exchange's own unrealized P&L, read here so a "profitable only"
      // scope needs no extra fetch. Null → 0, so an unreadable figure reads as
      // "not in profit" (excluded) rather than silently passing the scope.
      const pnl = "unRealizedProfit" in row ? (num(row.unRealizedProfit) ?? 0) : 0;
      meta.set(symbol, { notional, riskReward, entry, pnl });
      if ("profitLocked" in a && a.profitLocked === true) {
        locked.push({ symbol, long, size, mark });
      }

      // The `tighten` population: a stop ALREADY rests here, and the engine
      // says it is looser than the policy recommends — the state a position
      // in profit past 1×ATR reaches once the break-even lock is valid. The
      // resting level comes from the coverage matrix (`stopLoss.price`,
      // already filtered to a protective one) and the destination from the
      // same recommendation the naked rows read, so the two lists can never
      // disagree about a level. Mutually exclusive with `sl` by
      // construction: that one requires zero resting stops.
      if (
        // Only a venue with a stop-MOVE batch has an actionable tighten: a
        // resting stop that is too loose is otherwise not something this panel
        // can act on, and listing it would approve nothing.
        venue === "binance" &&
        restingStops != null &&
        restingStops > 0 &&
        "verdict" in a &&
        a.verdict === "tighten" &&
        "stopLoss" in row &&
        typeof row.stopLoss === "object" &&
        row.stopLoss != null &&
        "recommended" in a &&
        typeof a.recommended === "object" &&
        a.recommended != null
      ) {
        const rec = a.recommended;
        const to = "price" in rec ? num(rec.price) : null;
        const method = "method" in rec ? str(rec.method) : null;
        const from = "price" in row.stopLoss ? num(row.stopLoss.price) : null;
        // Only a strictly tighter, real destination — the same structural
        // gate the backend's move decision applies before it touches an
        // order. A level that is not tighter would be a loosen, and this
        // panel must never offer one.
        if (from != null && to != null && method != null && (long ? to > from : to < from)) {
          tightens.push({ symbol, long, size, mark, from, to, method });
        }
      }

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
        // A trailing-only exit carries no rungs and no band — without this the
        // whole row was dropped and the position looked like it had nothing to
        // place, which is exactly backwards for the runner leg.
        const trailingExit =
          "trailingExit" in tp &&
          typeof tp.trailingExit === "object" &&
          tp.trailingExit != null &&
          "price" in tp.trailingExit
            ? { method: str(tp.trailingExit.method) ?? "", price: num(tp.trailingExit.price) ?? 0 }
            : null;
        if (shape != null && (rungs.length > 0 || bandExit != null || trailingExit != null)) {
          tps.push({ symbol, long, size, mark, shape, rungs, bandExit, trailingExit });
        }
      }
    }
  }

  // Merge the three sides per symbol, first-seen order (the audit's
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
        entry: m?.entry ?? 0,
        notional: m?.notional ?? Math.abs(size * mark),
        pnl: m?.pnl ?? 0,
        riskReward: m?.riskReward ?? null,
        sl: null,
        tighten: null,
        tp: null,
        locked: false,
      };
      bySymbol.set(symbol, r);
    }
    return r;
  };
  for (const s of stops)
    touch(s.symbol, s.long, s.size, s.mark).sl = { price: s.price, method: s.method, distancePct: s.distancePct };
  for (const t of tps) touch(t.symbol, t.long, t.size, t.mark).tp = t;
  for (const t of tightens) {
    touch(t.symbol, t.long, t.size, t.mark).tighten = { from: t.from, to: t.to, method: t.method };
  }
  // Last, so a position that ALSO needs a take-profit keeps both sides: this
  // only fills the flag, never claims the row.
  for (const l of locked) touch(l.symbol, l.long, l.size, l.mark).locked = true;

  return {
    naked,
    noTp: Math.max(0, usdm - withTp),
    params: { interval, risk, limit },
    tightens,
    stops,
    tps,
    rows: [...bySymbol.values()],
  };
}

/** Compact counts from a placement op's JSON result.
 *
 * The `failures` rows are parsed, not discarded: each one carries the symbol
 * and the guard that rejected it (missing trading consent, a rate limit, a
 * crossed trigger…), and that text is the ONLY account of why a confirmed
 * approval placed nothing. Without it the panel could say "1 failed" and
 * nothing more — the operator had no way to act. */
export function placementSummary(raw: string): {
  placed: number;
  failed: number;
  note: string;
  failures: { symbol: string; error: string }[];
} | null {
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
  const failures =
    "failures" in v && Array.isArray(v.failures)
      ? v.failures
          .filter((f): f is Record<string, unknown> => typeof f === "object" && f != null)
          .map((f) => ({
            symbol: "symbol" in f ? (str(f.symbol) ?? "") : "",
            // The rejection reason rides `error`, or — when the grader had no
            // level to place — its first note.
            error:
              "error" in f && typeof f.error === "string"
                ? f.error
                : "notes" in f && Array.isArray(f.notes) && typeof f.notes[0] === "string"
                  ? f.notes[0]
                  : "rejected without a reason",
          }))
      : [];
  return { placed, failed, note: note ?? "", failures };
}

/** Compact counts from the stop-MOVE op's JSON result.
 *
 * The `stale` rows are the point of parsing this at all: a move places the
 * new stop and only then cancels the old one, so a cancel that could not be
 * confirmed leaves BOTH resting. That is harmless (both reduce-only) but the
 * operator has to be told, or the next audit shows a stop they did not
 * expect. */
export function tightenSummary(raw: string): {
  tightened: number;
  unchanged: number;
  noStop: number;
  failed: number;
  note: string;
  failures: { symbol: string; error: string }[];
  stale: { symbol: string; error: string }[];
} | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v == null || !("tightened" in v) || !("failed" in v)) return null;
  const tightened = num(v.tightened);
  const failed = num(v.failed);
  if (tightened == null || failed == null) return null;
  const failures =
    "failures" in v && Array.isArray(v.failures)
      ? v.failures
          .filter((f): f is Record<string, unknown> => typeof f === "object" && f != null)
          .map((f) => ({
            symbol: "symbol" in f ? (str(f.symbol) ?? "") : "",
            error: "error" in f && typeof f.error === "string" ? f.error : "rejected without a reason",
          }))
      : [];
  // Per moved position, the orders the move could NOT confirm canceled.
  const stale =
    "positions" in v && Array.isArray(v.positions)
      ? v.positions
          .filter((p): p is Record<string, unknown> => typeof p === "object" && p != null)
          .flatMap((p) =>
            ("stale" in p && Array.isArray(p.stale) ? p.stale : [])
              .filter((s): s is Record<string, unknown> => typeof s === "object" && s != null)
              .map((s) => ({
                symbol: "symbol" in p ? (str(p.symbol) ?? "") : "",
                error:
                  "error" in s && typeof s.error === "string"
                    ? s.error
                    : "the old stop may still be resting next to the new one",
              })),
          )
      : [];
  return {
    tightened,
    unchanged: "unchanged" in v ? (num(v.unchanged) ?? 0) : 0,
    noStop: "noStop" in v ? (num(v.noStop) ?? 0) : 0,
    failed,
    note: "note" in v ? (str(v.note) ?? "") : "",
    failures,
    stale,
  };
}

interface BinanceAuditOfferProps {
  /** Observability/session scope of the run whose audit is being offered on. */
  sessionId?: number | null;
  /** The audit run's plan key — scopes the full-output read. */
  planKey: string;
  /** The audit step's id (auditRunStep). */
  stepId: string;
  /** Whose book the audit graded — decides which placement ops this panel
   *  can call. */
  venue: AuditVenue;
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
export function BinanceAuditOffer({ planKey, stepId, venue, fetcher }: BinanceAuditOfferProps) {
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
  /** Find-a-position. A 182-row book in a 24rem scroll box is unsearchable by
   * scrolling, and hunting for one symbol is the most common thing a user does
   * here. Filters the VISIBLE list only — it never touches the selection. */
  const [query, setQuery] = useState("");
  /** Narrow by what the position is MISSING — the actual decision axis. */
  const [gap, setGap] = useState<"all" | "noStop" | "noTp" | "toTighten">("all");
  /** Only positions already in profit. A SEPARATE axis from `gap`, not a
   * fourth peer of it: "in profit AND no take-profit" is as legitimate a
   * review as "in profit AND no stop", and a single-select group could only
   * ever express one of the two. */
  const [winnersOnly, setWinnersOnly] = useState(false);

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

  const offer = parseAuditOffer(output, venue);
  if (readFailed || offer == null || offer.rows.length === 0) return null;

  const selectedRows = offer.rows.filter((r) => selected.has(r.symbol));
  const selectedStops = selectedRows.filter((r) => r.sl != null).length;
  const selectedTps = selectedRows.filter((r) => r.tp != null).length;
  const selectedTightens = selectedRows.filter((r) => r.tighten != null).length;
  const allSelected = selected.size === offer.rows.length;
  const noneSelected = selected.size === 0;
  // The scroll viewport is ~8 rows; the selection can be 183. Without this the
  // user arms a whole-book placement against a viewport showing 4% of it.
  const selectedNotional = selectedRows.reduce((sum, r) => sum + r.notional, 0);

  /** Visible rows: symbol search + missing-protection scope + winners-only.
   * Filtering narrows the VIEW only — the selection and the counts beside the
   * table always stay in terms of the whole book, so a filter can never
   * shrink what an approval would place. */
  const q = query.trim().toUpperCase();
  const matching = offer.rows.filter((r) => {
    // Strictly positive. A position at exactly break-even is not "in profit",
    // and a stop locked there buys nothing over a structural one.
    if (winnersOnly && !(r.pnl > 0)) return false;
    if (gap === "noStop" && r.sl != null) return false;
    if (gap === "toTighten" && r.tighten == null) return false;
    if (gap === "noTp" && r.tp != null) return false;
    return q.length === 0 || r.symbol.includes(q);
  });
  const filtered = matching.length !== offer.rows.length;
  const selectedInView = matching.filter((r) => selected.has(r.symbol)).length;
  /** Select all MATCHING — the only scope a user reading a filtered list can
   * reason about. Never silently widen to the whole book. */
  const selectMatching = () => setSelected(new Set(matching.map((r) => r.symbol)));

  /** One approval = up to three op calls (tighten existing stops, then place
   * missing stops, then missing take-profits), each scoped to the approved
   * symbol list. Level cap 500 = the backend's AUDIT_LIMIT_MAX, so an
   * approved whole-book selection is never silently truncated. */
  const executeRows = async (label: string, rows: OfferRow[]) => {
    if (busy || rows.length === 0) return;
    setBusy(true);
    setArmedKey(null);
    // A row can carry more than one side (a stop AND a take-profit, or a
    // tighten AND a take-profit), so each op gets the symbols that actually
    // need IT — never the whole selection, which would make the protect batch
    // re-place a stop the tighten batch just moved.
    const tightenSymbols = rows.filter((r) => r.tighten != null).map((r) => r.symbol);
    const slSymbols = rows.filter((r) => r.sl != null).map((r) => r.symbol);
    const tpSymbols = rows.filter((r) => r.tp != null).map((r) => r.symbol);
    const p = offer.params;
    const ops = PLACEMENT_OPS[venue];
    try {
      const out: string[] = [];
      if (ops.tighten != null && tightenSymbols.length > 0) {
        out.push(
          await call<string>(ops.tighten, {
            interval: p.interval,
            risk: p.risk,
            limit: 500,
            symbols: tightenSymbols,
          }),
        );
      }
      if (slSymbols.length > 0) {
        out.push(
          await call<string>(ops.protect, {
            interval: p.interval,
            risk: p.risk,
            limit: 500,
            symbols: slSymbols,
          }),
        );
      }
      if (tpSymbols.length > 0) {
        out.push(
          await call<string>(ops.takeProfit, {
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
  // Engine vocabulary is snake_case (chandelier_exit, keltner_10_2); spaced
  // out so it reads as a word rather than an identifier leaking into the UI.
  const human = (method: string) => method.replace(/_/g, " ");
  const tpCell = (tp: OfferRow["tp"]) => (
    <TpLadder bandExit={tp?.bandExit ?? null} rungs={tp?.rungs ?? []} trailingExit={tp?.trailingExit ?? null} />
  );

  return (
    <div className="border-primary/30 bg-card space-y-3 rounded-lg border p-4">
      <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs font-bold tracking-wider uppercase">
        <Icon name="shield-check" className="text-primary size-4" />
        Protect this book
      </div>
      {/* Four lines of mono prose explained what four chips say faster. */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 font-mono text-[0.6875rem]">
        <span className="rounded border px-1.5 py-0.5">{offer.params.interval} candles</span>
        <span className="rounded border px-1.5 py-0.5">{offer.params.risk} stops</span>
        <span className="rounded border px-1.5 py-0.5">{VENUE_LABEL[venue]} · USDⓈ-M</span>
        <span className="rounded border px-1.5 py-0.5">standard take-profit</span>
        <span className="text-destructive rounded border px-1.5 py-0.5">{offer.naked} without a stop</span>
        <span className="rounded border px-1.5 py-0.5">{offer.noTp} without a take-profit</span>
        {PLACEMENT_OPS[venue].tighten != null && (
          <span className="text-success rounded border px-1.5 py-0.5">{offer.tightens.length} stop to lock in</span>
        )}
      </div>
      <p className="text-muted-foreground text-xs">
        Approve the rows you want protected — one, a subset, or all.
        {offer.naked > offer.stops.length &&
          ` This audit graded only the ${offer.params.limit} largest, so ${offer.naked - offer.stops.length} smaller unprotected positions are not listed; re-run with "Positions graded: All" to cover the whole book.`}
      </p>

      <div className="space-y-1.5">
        {/* 182 rows in a scroll box is a haystack. Search + a gap filter are
            how one position gets found; neither touches the selection. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <SymbolSearch ariaLabel="Search positions by symbol" onQuery={setQuery} query={query} />
          {(
            [
              ["all", "Semua"],
              ["noStop", "Tanpa stop"],
              ["noTp", "Tanpa take-profit"],
              // Only where the panel can act on a loose stop.
              ...(PLACEMENT_OPS[venue].tighten != null ? ([["toTighten", "Stop bisa ditarik"]] as const) : []),
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setGap(value)}
              aria-pressed={gap === value}
              disabled={busy}
              className={cn(
                "rounded-md border px-2 py-1 font-mono text-[0.6875rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                gap === value
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
          {/* A different AXIS from the gap chips above, so it is visually and
              spatially separate: gap = what is missing, this = the position's
              own state. It is a toggle, not a member of the single-select
              group — the two compose. */}
          <span className="bg-border/60 mx-0.5 h-4 w-px" aria-hidden />
          <button
            type="button"
            onClick={() => setWinnersOnly((v) => !v)}
            aria-pressed={winnersOnly}
            disabled={busy}
            title="Only positions currently in profit — the ones worth locking in with a break-even stop"
            className={cn(
              "rounded-md border px-2 py-1 font-mono text-[0.6875rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
              winnersOnly
                ? "border-success/40 bg-success/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
          >
            Dalam untung
          </button>
          <MatchCount filtered={filtered} matchCount={matching.length} total={offer.rows.length} unit="positions" />
        </div>
        {filtered && (
          <SelectMatchingButton
            disabled={busy || selectedInView === matching.length}
            matchCount={matching.length}
            onClick={selectMatching}
            selectedInView={selectedInView}
          />
        )}
        <div className="border-border/60 max-h-96 overflow-y-auto rounded-md border">
          <table className="w-full border-collapse font-mono text-[0.6875rem]">
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
                <th
                  className="p-1.5 text-right"
                  title="The unrealized profit or loss on the position right now — the scope the “Dalam untung” filter reads"
                >
                  P&amp;L
                </th>
                <th
                  className="p-1.5 text-right"
                  title="The price right now — the number every level is measured against"
                >
                  Mark
                </th>
                <th className="p-1.5" title="Where the position closes automatically if the price moves against you">
                  Stop (exit at a loss)
                </th>
                <th
                  className="p-1.5"
                  title="Where the position closes automatically at a profit, and how much of it closes there"
                >
                  Targets (exit at a profit)
                </th>
                <th
                  className="p-1.5 text-right"
                  title="For every 1 put at risk at the stop, how much the first profit target pays back"
                >
                  Risk : Reward
                </th>
                <th className="p-1.5" aria-label="Approve row" />
              </tr>
            </thead>
            <tbody>
              {matching.map((r) => {
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
                    {/* What the "Dalam untung" scope filters on, shown signed so
                        a green number can't be misread as a green-tinted
                        position value. */}
                    <td
                      className={cn(
                        "p-1.5 text-right tabular-nums",
                        r.pnl > 0 ? "text-success" : r.pnl < 0 ? "text-destructive" : "text-muted-foreground",
                      )}
                    >
                      {r.pnl === 0 ? "—" : fmtSigned(r.pnl)}
                    </td>
                    <td className="text-muted-foreground p-1.5 text-right tabular-nums">
                      {r.mark > 0 ? fmtPrice(r.mark) : "—"}
                    </td>
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
                      ) : r.tighten != null ? (
                        // A resting stop the engine wants TIGHTER. Both levels
                        // are shown, from → to, because the whole point of the
                        // row is the move: an arrow with only the destination
                        // would leave the operator unable to judge it.
                        <>
                          <span className="text-muted-foreground line-through">{fmtPrice(r.tighten.from)}</span>{" "}
                          <span className="text-foreground">→ {fmtPrice(r.tighten.to)}</span>{" "}
                          <span className="text-success">· {human(r.tighten.method)}</span>
                        </>
                      ) : (
                        // A resting stop at/beyond entry grades `ok` and has no
                        // side to fill, so without the flag this cell would
                        // read as the generic "already tight". The lock is the
                        // whole message: the trade cannot lose, and the only
                        // move left is to trail it higher.
                        <span
                          className={
                            r.locked ? "text-success text-[0.625rem]" : "text-muted-foreground/50 text-[0.625rem]"
                          }
                        >
                          {r.locked
                            ? "profit locked — trail it higher"
                            : r.pnl > 0
                              ? "stop is already tight"
                              : "no stop to place"}
                        </span>
                      )}
                    </td>
                    <td className="p-1.5">{tpCell(r.tp)}</td>
                    <td className="text-muted-foreground p-1.5 text-right tabular-nums">
                      {(() => {
                        // Prefer the engine's resting-pair figure; otherwise
                        // derive the ratio this approval would create, measured
                        // from ENTRY (the anchor the 1R/2R rungs use) rather
                        // than the mark, which has already run past a deep loss.
                        const rr =
                          r.riskReward ??
                          placedRR(
                            r.sl?.price ?? null,
                            r.tp?.rungs[0]?.price ?? r.tp?.trailingExit?.price ?? r.tp?.bandExit?.price ?? null,
                            r.entry > 0 ? r.entry : r.mark,
                          );
                        return rr !== null ? fmtRR(rr) : "—";
                      })()}
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
        {matching.length === 0 && (
          <div className="text-muted-foreground px-3 py-6 text-center text-xs">
            No position matches{q.length > 0 ? ` "${query.trim()}"` : ""}
            {gap !== "all" ? " with that gap" : ""}
            {winnersOnly ? " and is in profit" : ""}.
          </div>
        )}
        {/* The viewport is ~8 rows tall; a whole-book selection is not. The
            count and the exposure stay on screen so the armed action can never
            describe orders the user cannot see. */}
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 font-mono text-[0.6875rem]">
          <span>
            {noneSelected
              ? `Nothing selected — ${offer.rows.length} position${offer.rows.length === 1 ? "" : "s"} available`
              : `${selectedRows.length} of ${offer.rows.length} selected`}
          </span>
          {!noneSelected && <span className="text-foreground">{fmtMoney(selectedNotional)} exposure</span>}
        </div>
        {/* A reader who cannot tell a stop from a target cannot safely approve
            an order. Three plain sentences, once, rather than tooltips they
            have to discover. */}
        <dl className="text-muted-foreground grid gap-x-4 gap-y-0.5 text-[0.6875rem] sm:grid-cols-2">
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">Stop</dt>
            <dd>closes the whole position at a loss if the price moves against you</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">Targets</dt>
            <dd>closes part of it at a profit — e.g. 40% at one price, 30% at a higher one</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">Risk : Reward</dt>
            <dd>for every 1 put at risk, how much the first target pays back</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">Mark</dt>
            <dd>the price right now — the number every level is measured against</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">P&amp;L</dt>
            <dd>profit or loss on the position so far — “Dalam untung” shows only the positive ones</dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!allSelected && !noneSelected && !busy && (
          <Button onClick={toggleAll} size="sm" variant="outline">
            Select all {offer.rows.length}
          </Button>
        )}
        {armedKey === "bulk" ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-foreground font-mono text-[0.6875rem]">
              {selectedTightens > 0 && `Move ${selectedTightens} stop${selectedTightens === 1 ? "" : "s"} in, `}
              {selectedStops > 0 && `place ${selectedStops} stop${selectedStops === 1 ? "" : "s"}, `}
              {selectedTps > 0 && `${selectedTps} take-profit${selectedTps === 1 ? "" : "s"}, `}
              on {selectedRows.length} position{selectedRows.length === 1 ? "" : "s"} ({fmtMoney(selectedNotional)}{" "}
              exposure)?
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
              : [
                  selectedTightens > 0 ? `move ${selectedTightens} stop in` : null,
                  selectedStops > 0 ? `place ${selectedStops} stop${selectedStops === 1 ? "" : "s"}` : null,
                  selectedTps > 0 ? `${selectedTps} take-profit${selectedTps === 1 ? "" : "s"}` : null,
                ]
                  .filter((p) => p != null)
                  .join(" + ")}
          </Button>
        )}
      </div>

      {log.map((entry) => (
        <div key={entry.id} className="space-y-0.5">
          <div className="text-muted-foreground font-mono text-[0.625rem] tracking-wider uppercase">
            {entry.label === "selected" ? "Selected rows" : entry.label}
          </div>
          {entry.error != null ? (
            <span className="text-destructive block font-mono text-[0.6875rem]" role="alert">
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
        const tighten = summary == null ? tightenSummary(part) : null;
        if (summary == null && tighten == null) {
          return (
            <pre
              key={part.slice(0, 32)}
              className="text-muted-foreground overflow-x-auto font-mono text-[0.625rem] leading-relaxed"
            >
              {part}
            </pre>
          );
        }
        if (tighten != null) {
          return (
            <span key={part.slice(0, 32)} className="block w-full space-y-1">
              <span className="text-foreground flex flex-wrap items-center gap-1.5 font-mono text-[0.6875rem]">
                {tighten.failed > 0 || tighten.stale.length > 0 ? (
                  <Icon name="alert-circle" className="text-destructive size-3" />
                ) : (
                  <Icon name="check" className="text-success size-3" />
                )}
                {tighten.tightened} stop{tighten.tightened === 1 ? "" : "s"} moved in
                {tighten.failed > 0 && <span className="text-destructive">· {tighten.failed} failed</span>}
                {tighten.unchanged > 0 && (
                  <span className="text-muted-foreground">· {tighten.unchanged} already tight</span>
                )}
                {tighten.noStop > 0 && <span className="text-muted-foreground">· {tighten.noStop} without a stop</span>}
                {tighten.tightened > 0 && (
                  <span className="text-muted-foreground">— re-run the audit to refresh the verdicts</span>
                )}
                {tighten.note.length > 0 && (
                  <span className="text-muted-foreground block font-mono text-[0.625rem] leading-relaxed">
                    {tighten.note}
                  </span>
                )}
              </span>
              {tighten.stale.length > 0 && (
                <details className="rounded-md border border-[var(--tea-color-border-focus)]">
                  <summary className="cursor-pointer px-2 py-1 font-mono text-[0.625rem] select-none text-foreground">
                    {tighten.stale.length} old stop{tighten.stale.length === 1 ? "" : "s"} could not be confirmed
                    canceled
                  </summary>
                  <ul className="space-y-1 px-2.5 py-1.5 font-mono text-[0.6875rem]">
                    {tighten.stale.map((f) => (
                      <li key={`${f.symbol}:${f.error}`} className="text-muted-foreground">
                        <span className="text-foreground">{f.symbol || "position"}</span> — {f.error}
                      </li>
                    ))}
                  </ul>
                  <p className="text-muted-foreground px-2.5 pb-1.5 font-mono text-[0.625rem]">
                    Both stops are reduce-only, so the tighter one fires first — check the resting orders on the
                    exchange and cancel the older one by hand.
                  </p>
                </details>
              )}
              {tighten.failures.length > 0 && (
                <details className="border-destructive/30 rounded-md border">
                  <summary className="text-destructive cursor-pointer px-2 py-1 font-mono text-[0.625rem] select-none">
                    Why {tighten.failures.length} move{tighten.failures.length === 1 ? "" : "s"} failed
                  </summary>
                  <ul className="space-y-1 px-2.5 py-1.5 font-mono text-[0.6875rem]">
                    {tighten.failures.map((f) => (
                      <li key={`${f.symbol}:${f.error}`} className="text-muted-foreground">
                        <span className="text-foreground">{f.symbol || "position"}</span> — {f.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </span>
          );
        }
        // Unreachable: an unreadable part already returned the raw `<pre>`
        // above. Present so the branch below reads as non-null to the type
        // checker rather than asserting it.
        if (summary == null) return null;
        return (
          <span key={part.slice(0, 32)} className="block w-full space-y-1">
            <span className="text-foreground flex flex-wrap items-center gap-1.5 font-mono text-[0.6875rem]">
              {summary.failed > 0 ? (
                <Icon name="alert-circle" className="text-destructive size-3" />
              ) : (
                <Icon name="check" className="text-success size-3" />
              )}
              {summary.placed} order{summary.placed === 1 ? "" : "s"} placed
              {summary.failed > 0 && <span className="text-destructive">· {summary.failed} failed</span>}
              {summary.placed + summary.failed > 0 && (
                <span className="text-muted-foreground">— re-run the audit to refresh the verdicts</span>
              )}
              {summary.note.length > 0 && (
                <span className="text-muted-foreground block font-mono text-[0.625rem] leading-relaxed">
                  {summary.note}
                </span>
              )}
            </span>
            {summary.failures.length > 0 && (
              <details className="border-destructive/30 rounded-md border">
                <summary className="text-destructive cursor-pointer px-2 py-1 font-mono text-[0.625rem] select-none">
                  Why {summary.failures.length} order{summary.failures.length === 1 ? "" : "s"} failed
                </summary>
                <ul className="space-y-1 px-2.5 py-1.5 font-mono text-[0.6875rem]">
                  {summary.failures.map((f) => (
                    <li key={`${f.symbol}:${f.error}`} className="text-muted-foreground">
                      <span className="text-foreground">{f.symbol || "position"}</span> — {f.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </span>
        );
      })}
    </span>
  );
}
