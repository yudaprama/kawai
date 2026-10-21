import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { call, errText } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Dispatch key of the screener tool — identifies a screener run's step in
 * both live supervisor state and persisted run records. */
export const CRYPTO_SCREENER_TOOL = "crypto_screener";

/** Exchange label for placement results — the placement payload carries the
 * venue key (`venue: "binance"`), and the user must never have to guess which
 * exchange a confirmed order went to. */
const VENUE_LABEL: Record<string, string> = { binance: "Binance", mexc: "MEXC" };

/**
 * EVERY screener step of a run, in plan order.
 *
 * The fixed pipeline emits ONE `crypto_screener` step PER SCREEN
 * (`screener_plan.rs::build_screener_plan`), so a 7-setup run has 7 steps and
 * each holds its own hit list. Taking only the first shows one screen's slice
 * of the scan — measured on a 743-symbol run: 401 hits across the 7 steps,
 * while the first step (`oversold_rebound`) carried exactly 1. That is the
 * whole "hundreds of scans, one recommendation" bug.
 */
export function screenerRunStepIds(steps: { tool: string; stepId: string }[] | undefined | null): string[] {
  return (steps ?? []).filter((s) => s.tool === CRYPTO_SCREENER_TOOL).map((s) => s.stepId);
}

/** One screen's direction, as the catalog records it. A `neutral` screen has
 * no side and is NEVER offered — the engine refuses it too, and offering it
 * would promise something the backend cannot do. */
export type ScreenDirection = "long" | "short";

/** One hit the offer would open: the symbol, the setup that produced it, and
 * how strongly it fired. `last`/`change24hPct`/`score`/`reasons` come
 * straight from the screener step's own output — the offer renders the run's
 * findings. The one derived number is the Stop (1R) column: folded live by
 * `binance_screened_stop_preview` (the same policy execution guards with),
 * because a scan-time snapshot could be hours stale by the time the user
 * approves.
 *
 * A symbol can hit under SEVERAL screens. Each (symbol, screen) pair is its
 * own row because the side is derived from the screen: a symbol that fired
 * both a bullish and a bearish setup genuinely offers both directions, and
 * collapsing them would silently pick one. */
export interface ScreenedHit {
  symbol: string;
  screen: string;
  direction: ScreenDirection;
  last: number;
  change24hPct: number;
  score: number;
  reasons: string[];
  /** The user's OWN realized expectancy on this symbol, when the scan had
   * enough history to rank on it. `null` means no history — which is not the
   * same as zero. Carried so the offer can rank and LABEL consistently with
   * what the screener actually reported. */
  expectancy: number | null;
  trades: number | null;
  /** Distance (percent, absolute) from the last close to this hit's nearest
   * confirmed level, and how many pivots that level has. `null` when the
   * series produced no level. Carried so a `structure`-ranked run can be
   * ordered the way the engine ordered it instead of silently reverting to
   * score order. */
  levelDistancePct: number | null;
  levelTouches: number | null;
}

/** How the run ordered its hits, echoed from the screener output. */
export type ScreenerRanking = "score" | "liquidity" | "myPerformance" | "structure";

/** The user's own record on one symbol, as the screener reported it. */
export interface MyPerformance {
  trades: number;
  winRate: number;
  expectancy: number;
  profitFactor: number | null;
  totalRealizedPnl: number;
}

/** What the offer needs from the run: the market family and the interval the
 * scan ran on (both echoed back to the engine so the stop is folded over the
 * SAME candles the scan used), the actionable hits merged from EVERY screen's
 * step, and the scan's own totals for context. */
export interface ScreenerOffer {
  /** Exchange the scan read. `null` on a payload predating the venue key —
   * every such run was a Binance run, so a null reads as binance. */
  venue: string | null;
  universe: string;
  interval: string;
  /** Symbols folded in the scan, across all steps. */
  scanned: number;
  /** Hits the scan found across all steps — before the directional filter, so
   * a neutral screen's rows are visible as "found but not actionable" rather
   * than silently shrinking the count. */
  hitsTotal: number;
  /** Rows dropped because their setup has no direction. */
  neutralHits: number;
  /** Which ordering the screener applied. Carried so this view does not
   * re-sort by score behind the engine's back, and so the user can SEE when
   * their own history drove the order. */
  rankBy: ScreenerRanking;
  rankByAutomatic: boolean;
  /** How many symbols had enough of the user's own history to rank on;
   * `null` when the ranking was not performance-based. */
  rankedOn: number | null;
  hits: ScreenedHit[];
}

const num = (x: unknown): number | null => (typeof x === "number" && Number.isFinite(x) ? x : null);
const str = (x: unknown): string | null => (typeof x === "string" ? x : null);

/** Screen direction, duplicated from the engine's catalog
 * (`screener::SCREENS`). Only the two directional values are listed: a
 * neutral screen resolves to `null` and its row is dropped, so the UI can
 * never offer an entry the engine would refuse. */
const SCREEN_DIRECTIONS: Record<string, ScreenDirection> = {
  oversold_rebound: "long",
  macd_golden_cross: "long",
  macd_death_cross: "short",
  midband_reclaim: "long",
  uptrend_pullback: "long",
  rsi_overbought_uptrend: "short",
};

/** Merge EVERY screener step's full output into one offer.
 *
 * The pipeline emits one step PER SCREEN, so this takes the whole run's
 * outputs and unions their hit lists — reading a single step is the bug that
 * showed 1 recommendation out of a 743-symbol, 401-hit scan.
 *
 * Three filters are load-bearing, not cosmetic:
 * - **Only the `usdm` family.** A spot run has no futures trade client, so
 *   every symbol in it is un-actionable. The panel renders nothing rather
 *   than offering rows the engine would refuse.
 * - **Only directional screens.** A neutral setup ("squeeze watch") marks
 *   conditions without voting for a direction; there is nothing to enter on.
 *   The dropped count is REPORTED, so the panel can say "299 hits, 289 had no
 *   direction" instead of silently showing a fraction of the scan.
 * - **The first readable step decides the run's universe/interval.** A step
 *   that fails to parse is skipped; only an ALL-UNREADABLE run returns null,
 *   so a broken read never looks like "nothing to do".
 *
 * A symbol appearing under several screens yields one row per setup — the side
 * comes from the screen, so two rows for one symbol can genuinely mean two
 * different directions.
 */
export function parseScreenerOffer(outputs: (string | null | undefined)[]): ScreenerOffer | null {
  const hits: ScreenedHit[] = [];
  const seen = new Set<string>();
  let universe: string | null = null;
  let venue: string | null = null;
  let interval: string | null = null;
  let scanned = 0;
  let hitsTotal = 0;
  let neutralHits = 0;
  let readable = 0;
  let rankBy: ScreenerRanking = "score";
  let rankByAutomatic = false;
  let rankedOn: number | null = null;

  for (const output of outputs) {
    if (output == null) continue;
    let v: unknown;
    try {
      v = JSON.parse(output);
    } catch {
      continue;
    }
    if (typeof v !== "object" || v == null || Array.isArray(v)) continue;
    const o = v as Record<string, unknown>;
    // `hits` present but empty is a legitimate "this screen found nothing".
    if (!("hits" in o) || !Array.isArray(o.hits)) continue;
    const u = str(o.universe) ?? "";
    // A run is ONE market family AND ONE exchange; a step claiming otherwise
    // is a stale or foreign result, and honoring it would offer rows the
    // engine refuses. Absent venue = a pre-venue payload = Binance.
    if (universe != null && u !== universe) continue;
    const vv = str(o.venue) ?? "binance";
    if (venue != null && vv !== venue) continue;
    if (universe == null) {
      universe = u;
      venue = vv;
      interval = str(o.interval) ?? "4h";
    }
    readable += 1;
    scanned += num(o.scanned) ?? 0;
    hitsTotal += num(o.hitsTotal) ?? o.hits.length;
    // The engine's ordering, echoed. Every step of one run reports the same
    // value, so a later step cannot silently override an earlier one.
    const r = str(o.rankBy);
    if (r === "score" || r === "liquidity" || r === "myPerformance" || r === "structure") rankBy = r;
    if (o.rankByAutomatic === true) rankByAutomatic = true;
    const mps = o.myPerformanceSymbols;
    const ranked = typeof mps === "object" && mps != null ? num((mps as Record<string, unknown>).rankedOn) : null;
    if (ranked != null) rankedOn = ranked;
    for (const raw of o.hits) {
      if (typeof raw !== "object" || raw == null) continue;
      const h = raw as Record<string, unknown>;
      const symbol = str(h.symbol)?.trim().toUpperCase();
      const screen = str(h.screen)?.trim().toLowerCase();
      if (!symbol || !screen) continue;
      const direction = SCREEN_DIRECTIONS[screen];
      if (direction == null) {
        neutralHits += 1;
        continue; // neutral or unknown setup — nothing to enter on
      }
      const score = num(h.score);
      const mp = h.myPerformance;
      const myPerformance =
        typeof mp === "object" && mp != null
          ? {
              trades: num((mp as Record<string, unknown>).trades) ?? 0,
              winRate: num((mp as Record<string, unknown>).winRate) ?? 0,
              expectancy: num((mp as Record<string, unknown>).expectancy) ?? 0,
              profitFactor: num((mp as Record<string, unknown>).profitFactor),
              totalRealizedPnl: num((mp as Record<string, unknown>).totalRealizedPnl) ?? 0,
            }
          : null;
      const last = num(h.last);
      if (score == null || last == null) continue;
      const st =
        typeof h.structure === "object" && h.structure != null ? (h.structure as Record<string, unknown>) : null;
      const nl =
        st != null && typeof st.nearestLevel === "object" && st.nearestLevel != null
          ? (st.nearestLevel as Record<string, unknown>)
          : null;
      const levelDelta = num(nl?.distancePct);
      const reasons = Array.isArray(h.reasons) ? h.reasons.filter((x): x is string => typeof x === "string") : [];
      const key = `${symbol}|${screen}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({
        symbol,
        screen,
        direction,
        last,
        change24hPct: num(h.change24hPct) ?? 0,
        score,
        reasons,
        expectancy: myPerformance?.expectancy ?? null,
        trades: myPerformance?.trades ?? null,
        levelDistancePct: levelDelta == null ? null : Math.abs(levelDelta),
        levelTouches: num(nl?.touches),
      });
    }
  }

  if (readable === 0 || universe !== "usdm") return null;
  // Order by WHAT THE ENGINE DID, not by re-deriving a score order here. The
  // previous unconditional `b.score` sort silently discarded the engine's
  // ranking whenever it had history to rank on, so a user asking for a
  // performance-based scan saw exactly the old order back. Same rule as
  // `compare_hits` in the engine: performance first, then score, then symbol.
  hits.sort((a, b) => {
    if (rankBy === "myPerformance") {
      const ae = a.expectancy;
      const be = b.expectancy;
      const ah = ae != null;
      const bh = be != null;
      if (ah !== bh) return ah ? -1 : 1;
      if (ae != null && be != null && ae !== be) return be - ae;
    }
    if (rankBy === "structure") {
      // Same rule as `compare_hits` in the engine: tightest level first,
      // most-respected level breaking a tie, no level last.
      const ad = a.levelDistancePct;
      const bd = b.levelDistancePct;
      const ah = ad != null;
      const bh = bd != null;
      if (ah !== bh) return ah ? -1 : 1;
      if (ad != null && bd != null && ad !== bd) return ad - bd;
      const at = a.levelTouches ?? 0;
      const bt = b.levelTouches ?? 0;
      if (at !== bt) return bt - at;
    }
    return b.score - a.score || a.symbol.localeCompare(b.symbol);
  });
  return {
    venue,
    universe,
    interval: interval ?? "4h",
    scanned,
    hitsTotal,
    neutralHits,
    rankBy,
    rankByAutomatic,
    rankedOn,
    hits,
  };
}

/** Read the human-usable numbers out of the engine's entry response: the
 * counts up front and the rows that need attention. A position that filled
 * but ended up WITHOUT its stop is the one outcome that must never be buried
 * in a success count — and a position with no resting take-profit (the
 * ladder was requested, no rung could rest) is the next one. */
export function placementSummary(raw: string): {
  venue: string | null;
  opened: number;
  failed: number;
  unprotected: number;
  noTp: number;
  note: string;
  failures: { symbol: string; error: string }[];
  naked: { symbol: string; error: string }[];
} | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v == null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const opened = num(o.opened);
  const failed = num(o.failed);
  if (opened == null || failed == null) return null;
  const rows = (key: string) =>
    o[key] && Array.isArray(o[key])
      ? (o[key] as unknown[])
          .filter((x): x is Record<string, unknown> => typeof x === "object" && x != null)
          .map((r) => ({
            symbol: str(r.symbol) ?? "",
            error: str(r.error) ?? "no reason given",
          }))
      : [];
  return {
    venue: str(o.venue),
    opened,
    failed,
    unprotected: num(o.unprotected) ?? 0,
    noTp: num(o.noTakeProfit) ?? 0,
    note: str(o.note) ?? "",
    failures: rows("failures"),
    naked: rows("unprotectedPositions"),
  };
}

/** One row of the pre-approval stop preview (`binance_screened_stop_preview`):
 * the level the engine's guard policy computes for this (symbol, screen) over
 * fresh public candles — the identical fold execution runs at order time.
 * Keyless and read-only. */
export interface StopPreview {
  ok: boolean;
  stopPrice?: number;
  stopMethod?: string;
  /** |mark − stop| / mark × 100 — this distance IS 1R at the preset. */
  stopDistancePct?: number;
  error?: string;
}

/** The preview folds stops for at most this many ranked hits — the panel
 * renders the top of the ranking, and a 400-row preview would hammer public
 * klines for rows nobody will open. Must stay ≤ the engine's own
 * `PREVIEW_CAP` (100), which truncates silently. */
export const PREVIEW_CAP = 50;

/** The (symbol, screen) pairs to preview: the top of the ranking, in rank
 * order, capped. */
export function previewTargets(
  hits: { symbol: string; screen: string }[],
  cap: number = PREVIEW_CAP,
): { symbol: string; screen: string }[] {
  return hits.slice(0, cap).map((h) => ({ symbol: h.symbol, screen: h.screen }));
}

/** Default position size in USDT, and the per-symbol cap. Sized by the user,
 * never derived from the account: the engine has no futures balance read, so
 * an auto-sized default would be kawai guessing how much of someone's money
 * to risk. */
const DEFAULT_NOTIONAL = 25;
const NOTIONAL_MIN = 1;
const NOTIONAL_MAX = 10_000;

interface CryptoScreenerOfferProps {
  /** The run's plan key — scopes the full-output read. */
  planKey: string;
  /** EVERY screener step of the run, in plan order. The pipeline emits one
   * step per screen, so a multi-setup run needs all of them read — or the
   * offer shows one screen's slice of the scan. */
  stepIds: string[];
  /** Full-output fetcher — the same loader the canvas step reports use. */
  fetcher: (stepId: string, planKey?: string) => Promise<string | null>;
}

/** Post-screener entry offer.
 *
 * Unlike the audit's offer this OPENS positions, so the panel is built around
 * three facts the user must be able to see before approving:
 * - **Nothing is selected on arrival.** An approval two clicks from real money
 *   must be a deliberate act, so "Select all" is a button, never a resting
 *   state.
 * - **The direction is shown, never chosen.** The side comes from the screen
 *   that produced the hit; the user picks a size and says yes.
 * - **The exposure is on screen before the arm step.** A whole-selection
 *   approval can be larger than the visible viewport, so the running total
 *   and the position count stay beside the table.
 *
 * Every action arms first: the confirmation click, nothing earlier, sends real
 * orders. The approved list IS the request — the backend never widens it back
 * to every hit. */
export function CryptoScreenerOffer({ planKey, stepIds, fetcher }: CryptoScreenerOfferProps) {
  const [outputs, setOutputs] = useState<(string | null)[]>([]);
  const [readFailed, setReadFailed] = useState(false);
  /** Keyed by `${symbol}|${screen}` — one row can be the same symbol under a
   * different setup, and each is a genuinely different order. */
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  /** Per-row notional, in USDT. Seeding one default for every row keeps the
   * common case to "tick the boxes, confirm". */
  const [notionals, setNotionals] = useState<Record<string, number>>({});
  /** "bulk" | `row:${key}` — only one arm at a time. */
  const [armedKey, setArmedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [minScore, setMinScore] = useState<number>(0);
  /** Keyed by `${symbol}|${screen}` — the pre-approval stop fold per hit. */
  const [previews, setPreviews] = useState<Record<string, StopPreview>>({});
  const [previewPending, setPreviewPending] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  /** Whether the approval also places the standard-style take-profit ladder.
   * Default ON: an entry without a target is half a trade. */
  const [withTp, setWithTp] = useState(true);
  const logIdRef = useRef(0);
  const [log, setLog] = useState<{ id: number; label: string; raw?: string; error?: string }[]>([]);

  // Read every step in parallel: the offer merges them into one hit list, so
  // a partial failure degrades to fewer rows rather than an empty panel.
  //
  // `stepIds` is a fresh array on every parent render, so it cannot be the
  // effect dependency directly (it would refetch forever). Its CONTENTS are
  // the identity that matters: the joined string changes exactly when the
  // set of steps does.
  const stepKey = stepIds.join(",");
  useEffect(() => {
    const ids = stepKey.length === 0 ? [] : stepKey.split(",");
    let alive = true;
    setOutputs([]);
    setReadFailed(false);
    setSelected(new Set());
    setNotionals({});
    setArmedKey(null);
    setQuery("");
    setMinScore(0);
    setPreviews({});
    setPreviewPending(false);
    setPreviewFailed(false);
    setWithTp(true);
    if (ids.length === 0) {
      setReadFailed(true);
      return;
    }
    void Promise.all(ids.map((id) => fetcher(id, planKey).catch(() => null))).then(async (results) => {
      if (!alive) return;
      // Every read failed → the run view is broken, which must not read as
      // "the scan found nothing".
      if (results.every((r) => r == null)) {
        setReadFailed(true);
        return;
      }
      setOutputs(results);
      // The stop preview rides the same read: once the merged offer exists,
      // fold the engine's stop policy over fresh public candles for the top
      // of the ranking — the numbers the user reasons about BEFORE arming an
      // order. Keyless and read-only; a failure degrades to "—" cells, never
      // to a broken panel.
      const parsed = parseScreenerOffer(results);
      if (parsed == null || parsed.hits.length === 0) return;
      // A MEXC run offers nothing to place, so the Binance stop preview has
      // nothing to annotate — skip the fetch entirely.
      if (parsed.venue === "mexc") {
        setPreviewPending(true);
        try {
          const out = await call<string>("mexc_screened_stop_preview", {
            picks: previewTargets(parsed.hits).map((p) => [p.symbol, p.screen] as [string, string]),
            interval: parsed.interval,
            risk: "standard",
          });
          if (!alive) return;
          const rows = JSON.parse(out) as { previews?: (StopPreview & { symbol: string; screen: string })[] };
          const map: Record<string, StopPreview> = {};
          for (const p of rows.previews ?? []) map[`${p.symbol}|${p.screen}`] = p;
          setPreviews(map);
        } catch {
          if (alive) setPreviewFailed(true);
        } finally {
          if (alive) setPreviewPending(false);
        }
        return;
      }
      setPreviewPending(true);
      try {
        const out = await call<string>("binance_screened_stop_preview", {
          picks: previewTargets(parsed.hits),
          interval: parsed.interval,
          risk: "standard",
        });
        if (!alive) return;
        const rows = JSON.parse(out) as {
          previews?: (StopPreview & { symbol: string; screen: string })[];
        };
        const map: Record<string, StopPreview> = {};
        for (const p of rows.previews ?? []) map[`${p.symbol}|${p.screen}`] = p;
        setPreviews(map);
      } catch {
        if (alive) setPreviewFailed(true);
      } finally {
        if (alive) setPreviewPending(false);
      }
    });
    return () => {
      alive = false;
    };
  }, [fetcher, planKey, stepKey]);

  const offer = parseScreenerOffer(outputs);
  // An empty hit list is a real answer ("the screen fired nowhere"), and it
  // gets an explicit empty state rather than vanishing — the same "did nothing
  // happen, or is something broken?" question the audit offer answers.
  if (readFailed || offer == null) return null;
  // MEXC hits are read-only: no selection, no sizes, no placement — the panel
  // is a report of where setups fired, nothing more. Absent venue = a
  // pre-venue payload = a Binance run, so the placement path is unchanged.
  const venueLabel = VENUE_LABEL[offer.venue ?? "binance"] ?? "Binance";

  const rowKey = (h: ScreenedHit) => `${h.symbol}|${h.screen}`;
  const q = query.trim().toUpperCase();
  const matching = offer.hits.filter((h) => (q.length === 0 || h.symbol.includes(q)) && h.score >= minScore);
  const filtered = matching.length !== offer.hits.length;
  const selectedHits = offer.hits.filter((h) => selected.has(rowKey(h)));
  const allSelected = selected.size === offer.hits.length;
  const noneSelected = selected.size === 0;
  const selectedInView = matching.filter((h) => selected.has(rowKey(h))).length;
  const previewedKeys = new Set(offer.hits.slice(0, PREVIEW_CAP).map(rowKey));

  /** What one row's Stop (1R) cell shows, in priority order: the folded level
   * (its distance IS 1R at the preset), the guard refusal execution would
   * raise, the loading state, or the honest dash — preview unavailable or
   * beyond the cap is NOT the same as "no stop", so it never borrows that
   * wording. */
  const previewCell = (key: string) => {
    if (!previewedKeys.has(key)) {
      return (
        <span className="text-muted-foreground" title={`Preview covers the top ${PREVIEW_CAP} ranked hits`}>
          —
        </span>
      );
    }
    if (previewPending) {
      return <span className="text-muted-foreground">…</span>;
    }
    const pv = previews[key];
    if (pv == null) {
      return (
        <span
          className="text-muted-foreground"
          title={previewFailed ? "Preview failed — the level still computes at execution" : "No preview for this row"}
        >
          —
        </span>
      );
    }
    if (!pv.ok) {
      return (
        <span className="text-warning" title={pv.error ?? "No stop level survived the guards"}>
          refused
        </span>
      );
    }
    return (
      <span
        className="text-foreground"
        title={`${pv.stopMethod} stop at ${usd(pv.stopPrice ?? 0)} — execution refolds this level at order time`}
      >
        {pv.stopDistancePct?.toFixed(1)}%
      </span>
    );
  };

  /** The exposure an approval would commit — floored to the engine's own
   * minimum so the number on screen is never below what the order can be.
   * The backend does the real flooring to the lot step; this is the figure the
   * user reasons about. */
  const selectedNotional = selectedHits.reduce((sum, h) => sum + (notionals[rowKey(h)] ?? DEFAULT_NOTIONAL), 0);

  const selectMatching = () => {
    setSelected(new Set(matching.map(rowKey)));
    setNotionals((prev) => {
      const next = { ...prev };
      for (const h of matching) {
        const k = rowKey(h);
        if (next[k] == null) next[k] = DEFAULT_NOTIONAL;
      }
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
      return;
    }
    selectMatching();
  };

  const toggleRow = (key: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const setNotional = (key: string, value: number) => setNotionals((prev) => ({ ...prev, [key]: value }));

  /** One approval = ONE call carrying exactly the selected rows. The interval
   * rides along so the attached stop folds over the same candles the scan
   * used; the risk preset is the engine's standard default. */
  const execute = async (label: string, hits: ScreenedHit[]) => {
    if (busy || hits.length === 0) return;
    setBusy(true);
    setArmedKey(null);
    try {
      const endpoint = offer.venue === "mexc" ? "mexc_open_screened_positions" : "binance_open_screened_positions";
      const payload: Record<string, unknown> = {
        picks: hits.map((h) => ({
          symbol: h.symbol,
          // The screen, never a side: the engine derives the direction from it.
          screen: h.screen,
          notional: notionals[rowKey(h)] ?? DEFAULT_NOTIONAL,
        })),
        interval: offer.interval,
        risk: "standard",
      };
      if (offer.venue !== "mexc") payload.takeProfit = withTp;
      const out = await call<string>(endpoint, payload);
      const id = ++logIdRef.current;
      setLog((l) => [...l, { id, label, raw: out }]);
      // The rows that were approved are now positions — leaving them ticked
      // would let a second click re-send them.
      setSelected(new Set());
    } catch (e) {
      const id = ++logIdRef.current;
      setLog((l) => [...l, { id, label, error: errText(e) }]);
    } finally {
      setBusy(false);
    }
  };

  // Engine/screen vocabulary is snake_case; spaced out so it reads as a word
  // rather than an identifier leaking into the UI.
  const human = (name: string) => name.replace(/_/g, " ");
  const usd = (n: number) => `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  if (offer.hits.length === 0) {
    // Two very different outcomes must not look alike: the scan found
    // nothing, or it found plenty but every hit was directionless. The second
    // is a real answer about the user's setup choice, not a broken panel.
    const allNeutral = offer.neutralHits > 0;
    return (
      <div className="border-border/60 bg-card space-y-1 rounded-lg border p-4">
        <div className="text-muted-foreground inline-flex items-center gap-2 font-mono text-xs font-bold tracking-wider uppercase">
          <Icon name="scan-search" className="size-4" />
          Open a screened position
        </div>
        <p className="text-muted-foreground text-xs">
          {allNeutral ? (
            <>
              The scan fired on {offer.neutralHits} symbol{offer.neutralHits === 1 ? "" : "s"}, but every hit came from
              a directionless setup — those mark conditions without voting for a side, so there is nothing to enter on.
              Add a setup that picks a direction (oversold rebound, MACD cross, midband reclaim) and re-run.
            </>
          ) : (
            <>
              This run&rsquo;s scan fired on no symbols, so there is nothing to open. Re-run the screener with a
              different setup or a wider universe.
            </>
          )}
        </p>
      </div>
    );
  }

  return (
    <div className="border-destructive/30 bg-card space-y-3 rounded-lg border p-4">
      <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs font-bold tracking-wider uppercase">
        <Icon name="trending-up" className="text-destructive size-4" />
        Open these as positions
      </div>
      {/* The scan's OWN totals, so the rows below are visibly a fraction of what
          was searched rather than the whole job — and a run whose steps were
          only partly readable says so. */}
      <div className="text-muted-foreground flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
        <span className="rounded border px-1.5 py-0.5">{venueLabel} · USDⓈ-M futures</span>
        <span className="rounded border px-1.5 py-0.5">{offer.interval} candles</span>
        <span className="rounded border px-1.5 py-0.5">standard stops</span>
        <span className="text-foreground rounded border px-1.5 py-0.5">
          {offer.hits.length} of {offer.hitsTotal} hits from {offer.scanned} symbols
        </span>
        {/* Which ordering actually ran. Without this the list can silently
            reorder away from the technical score and the user has no way to
            tell why. */}
        <span
          className="rounded border px-1.5 py-0.5"
          title={
            offer.rankBy === "myPerformance"
              ? `Ordered by your own realized record${offer.rankByAutomatic ? " (automatic)" : ""} — symbols you have actually been profitable on come first, ahead of the technical score.`
              : offer.rankBy === "structure"
                ? "Ordered by the distance to each hit's nearest confirmed level — the tightest stop first, the level the market has respected most often breaking a tie, hits without a level last."
                : "Ordered by the engine's technical conviction score."
          }
        >
          ranked:{" "}
          {offer.rankBy === "myPerformance"
            ? offer.rankByAutomatic
              ? `your record${offer.rankedOn ? ` (${offer.rankedOn})` : ""}`
              : "your record"
            : offer.rankBy === "liquidity"
              ? "liquidity"
              : offer.rankBy === "structure"
                ? "structure"
                : "score"}
        </span>
        {offer.neutralHits > 0 && (
          <span
            className="rounded border px-1.5 py-0.5"
            title="These fired but their setup names no direction, so there is nothing to enter on"
          >
            {offer.neutralHits} directionless
          </span>
        )}
        <span className="text-destructive rounded border px-1.5 py-0.5">real orders — not a preview</span>
      </div>
      <p className="text-muted-foreground text-xs">
        These are this run&rsquo;s own hits. Pick the ones you want, set a size for each, and approve — every position
        opens with its protective stop already resting, and with the ladder on its take-profit rungs rest too. Kawai
        never opens a position it cannot place a stop for.
      </p>

      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari simbol… (mis. BTC)"
            aria-label="Search hits by symbol"
            className="border-input bg-input/20 h-7 w-44 rounded-md border px-2 font-mono text-[11px] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
          />
          {/* Conviction is the decision axis for a screener hit, so it is a
              single-select threshold — including "any" (0). */}
          {(
            [
              [0, "Any"],
              [50, "Score 50+"],
              [70, "Score 70+"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setMinScore(value)}
              aria-pressed={minScore === value}
              disabled={busy}
              className={cn(
                "rounded-md border px-2 py-1 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                minScore === value
                  ? "border-primary/40 bg-primary/10 text-foreground"
                  : "border-border text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
          <label
            className="text-muted-foreground flex cursor-pointer items-center gap-1.5 font-mono text-[11px]"
            title="Also place the take-profit ladder with each entry (1R/2R partials at the standard style, runner trails on the advisory levels) — levels are engine-computed from the attached stop. A rung that cannot rest is reported, never retried."
          >
            <input
              type="checkbox"
              checked={withTp}
              onChange={(e) => setWithTp(e.target.checked)}
              disabled={busy}
              className="accent-primary"
            />
            Take-profit ladder
          </label>
          <span className="text-muted-foreground ml-auto font-mono text-[11px] tabular-nums">
            {filtered ? `${matching.length} of ${offer.hits.length}` : `${offer.hits.length} hits`}
          </span>
        </div>
        {filtered && (
          <button
            type="button"
            onClick={selectMatching}
            disabled={busy || selectedInView === matching.length}
            className="text-muted-foreground hover:text-foreground text-xs underline disabled:cursor-not-allowed disabled:opacity-50"
          >
            Select the {matching.length} shown{selectedInView > 0 ? ` (${selectedInView} already selected)` : ""}
          </button>
        )}
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
                    aria-label="Select all hits"
                    className="accent-primary"
                  />
                </th>
                <th className="p-1.5">Symbol</th>
                <th className="p-1.5">Side</th>
                <th className="p-1.5">Setup</th>
                <th
                  className="p-1.5 text-right"
                  title="The protective stop the engine's policy folds over fresh candles for this setup — its distance IS 1R. Execution re-folds the level at order time."
                >
                  Stop (1R)
                </th>
                <th
                  className="p-1.5 text-right"
                  title="How strongly the setup fired, 0–100 — the screener's own conviction score"
                >
                  Score
                </th>
                <th className="p-1.5 text-right" title="Price at the moment of the scan — the order fills at market">
                  Last
                </th>
                <th
                  className="p-1.5 text-right"
                  title="The 24-hour change when the scan ran, for context on where the setup fired"
                >
                  24h
                </th>
                <th className="p-1.5 text-right" title="Position size in USDT — the amount committed per position">
                  Size (USDT)
                </th>
                <th className="p-1.5" aria-label="Approve row" />
              </tr>
            </thead>
            <tbody>
              {matching.map((h) => {
                const k = rowKey(h);
                return (
                  <tr
                    key={k}
                    className={cn(
                      "border-border/40 hover:bg-muted/20 border-b last:border-b-0",
                      selected.has(k) && "bg-primary/5",
                    )}
                  >
                    <td className="p-1.5">
                      <input
                        type="checkbox"
                        checked={selected.has(k)}
                        onChange={() => toggleRow(k)}
                        disabled={busy}
                        aria-label={`Select ${h.symbol} ${human(h.screen)}`}
                        className="accent-primary"
                      />
                    </td>
                    <td className="text-foreground p-1.5">{h.symbol}</td>
                    <td className={cn("p-1.5", h.direction === "long" ? "text-success" : "text-destructive")}>
                      {h.direction === "long" ? "long" : "short"}
                    </td>
                    <td className="text-muted-foreground p-1.5">{human(h.screen)}</td>
                    <td className="p-1.5 text-right">{previewCell(k)}</td>
                    <td className="text-foreground p-1.5 text-right tabular-nums">{Math.round(h.score)}</td>
                    <td className="text-foreground p-1.5 text-right tabular-nums">{usd(h.last)}</td>
                    <td
                      className={cn(
                        "p-1.5 text-right tabular-nums",
                        h.change24hPct >= 0 ? "text-success" : "text-destructive",
                      )}
                    >
                      {h.change24hPct >= 0 ? "+" : ""}
                      {h.change24hPct.toFixed(2)}%
                    </td>
                    <td className="p-1.5 text-right">
                      <input
                        type="number"
                        min={NOTIONAL_MIN}
                        max={NOTIONAL_MAX}
                        step={5}
                        value={notionals[k] ?? DEFAULT_NOTIONAL}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          if (Number.isFinite(v) && v > 0) setNotional(k, Math.min(v, NOTIONAL_MAX));
                        }}
                        disabled={busy}
                        aria-label={`Size in USDT for ${h.symbol}`}
                        className="border-input bg-input/20 h-6 w-20 rounded border px-1.5 text-right tabular-nums outline-none focus-visible:border-ring disabled:opacity-50"
                      />
                    </td>
                    <td className="p-1.5">
                      {selected.has(k) ? (
                        armedKey === `row:${k}` ? (
                          <span className="flex items-center gap-1">
                            <Button
                              disabled={busy}
                              onClick={() => void execute(h.symbol, [h])}
                              size="sm"
                              variant="destructive"
                            >
                              Confirm
                            </Button>
                            <Button disabled={busy} onClick={() => setArmedKey(null)} size="sm" variant="outline">
                              Cancel
                            </Button>
                          </span>
                        ) : (
                          <Button
                            disabled={busy}
                            onClick={() => setArmedKey(`row:${k}`)}
                            size="sm"
                            variant="destructive"
                          >
                            Open
                          </Button>
                        )
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {matching.length === 0 && (
          <div className="text-muted-foreground px-3 py-6 text-center text-xs">
            No hit matches{q.length > 0 ? ` "${query.trim()}"` : ""}
            {minScore > 0 ? ` with score ${minScore}+` : ""}.
          </div>
        )}
        {/* The viewport is ~8 rows tall; a whole-selection approval is not.
            The count and the committed capital stay on screen so an armed
            action can never describe orders the user cannot see. */}
        <div className="text-muted-foreground flex flex-wrap items-center justify-between gap-2 font-mono text-[11px]">
          <span>
            {noneSelected
              ? `Nothing selected — ${offer.hits.length} hit${offer.hits.length === 1 ? "" : "s"} available`
              : `${selectedHits.length} of ${offer.hits.length} selected`}
          </span>
          {!noneSelected && <span className="text-foreground">{usd(selectedNotional)} committed</span>}
        </div>
        {/* A user who cannot tell a setup from a direction cannot safely
            approve an order. Plain sentences, once. */}
        <dl className="text-muted-foreground grid gap-x-4 gap-y-0.5 text-[11px] sm:grid-cols-2">
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">Setup</dt>
            <dd>the screen that fired — kawai reads the direction from it, you never pick a side</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">Score</dt>
            <dd>how strongly the setup fired, 0–100 — the screener&rsquo;s own conviction</dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">Size</dt>
            <dd>
              USDT committed per position; the order fills at market and is floored to the exchange&rsquo;s lot step
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">Stop</dt>
            <dd>
              placed automatically with every entry at the engine&rsquo;s recommended level — if no level qualifies,
              nothing opens
            </dd>
          </div>
          <div className="flex gap-1.5">
            <dt className="text-foreground shrink-0 font-medium">Take profit</dt>
            <dd>
              optional ladder placed with the entry (1R/2R partials, runner trails) — engine-computed from the attached
              stop; a rung that cannot rest is reported in the result, never retried
            </dd>
          </div>
        </dl>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {!allSelected && !noneSelected && !busy && (
          <Button onClick={toggleAll} size="sm" variant="outline">
            Select all {offer.hits.length}
          </Button>
        )}
        {armedKey === "bulk" ? (
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-foreground font-mono text-[11px]">
              Open {selectedHits.length} position{selectedHits.length === 1 ? "" : "s"} for {usd(selectedNotional)}?
            </span>
            <Button
              disabled={busy}
              onClick={() => void execute("selected", selectedHits)}
              size="sm"
              variant="destructive"
            >
              Confirm
            </Button>
            <Button disabled={busy} onClick={() => setArmedKey(null)} size="sm" variant="outline">
              Cancel
            </Button>
          </span>
        ) : (
          <Button
            disabled={busy || selectedHits.length === 0}
            onClick={() => setArmedKey("bulk")}
            size="sm"
            variant="destructive"
          >
            {busy ? (
              <Icon name="loader-circle" className="size-3 animate-spin" />
            ) : (
              <Icon name="trending-up" className="size-3" />
            )}
            {/* The consequence belongs on the FIRST click, not only on the
                arm step. */}
            {selectedHits.length === 0
              ? "Select hits to open"
              : `Open ${selectedHits.length} position${selectedHits.length === 1 ? "" : "s"} (${usd(selectedNotional)})`}
          </Button>
        )}
      </div>

      {log.map((entry) => {
        const summary = placementSummary(entry.raw ?? "");
        return (
          <div key={entry.id} className="space-y-0.5">
            <div className="text-muted-foreground font-mono text-[10px] tracking-wider uppercase">
              {entry.label === "selected" ? "Selected hits" : entry.label}
            </div>
            {entry.error != null ? (
              <span className="text-destructive block font-mono text-[11px]" role="alert">
                {entry.error}
              </span>
            ) : summary == null ? (
              <span className="text-muted-foreground block font-mono text-[11px]">{entry.raw}</span>
            ) : (
              <div className="space-y-1">
                <div className="text-foreground font-mono text-[11px]">
                  Opened {summary.opened} · failed {summary.failed}
                  {summary.venue && (
                    <span className="text-muted-foreground"> · on {VENUE_LABEL[summary.venue] ?? summary.venue}</span>
                  )}
                  {summary.unprotected > 0 && (
                    <span className="text-destructive"> · {summary.unprotected} without a stop</span>
                  )}
                  {summary.noTp > 0 && <span className="text-warning"> · {summary.noTp} without take-profit</span>}
                </div>
                {summary.note && <p className="text-muted-foreground text-[11px]">{summary.note}</p>}
                {/* A filled position with no stop is the one outcome that must
                    never hide behind a success count — it is listed first and
                    in the destructive colour. */}
                {summary.naked.length > 0 && (
                  <ul className="text-destructive space-y-0.5 font-mono text-[11px]">
                    {summary.naked.map((n) => (
                      <li key={`naked-${n.symbol}`}>
                        <span className="font-bold">{n.symbol}</span> — {n.error}
                      </li>
                    ))}
                  </ul>
                )}
                {summary.failures.length > 0 && (
                  <details className="text-muted-foreground font-mono text-[11px]">
                    <summary>{summary.failures.length} not opened</summary>
                    <ul className="mt-0.5 space-y-0.5">
                      {summary.failures.map((f) => (
                        <li key={`fail-${f.symbol}`}>
                          <span className="text-foreground">{f.symbol}</span> — {f.error}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
          </div>
        );
      })}

      {/* What this panel can and cannot do, stated where the arm happens —
          not in a tooltip the user has to discover. */}
      <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
        <Icon name="shield-alert" className="text-warning mt-0.5 size-3.5 shrink-0" />
        <span>
          These are real market orders that open leveraged positions — kawai will spend up to 3 positions a minute here,
          far below the limit for protective orders. Every entry gets a stop attached automatically; if the stop cannot
          be placed, the result says so explicitly instead of reporting a clean success. Your exchange leverage and
          margin settings are never changed by kawai.
          {busy && " Placing orders…"}
        </span>
      </p>
    </div>
  );
}
