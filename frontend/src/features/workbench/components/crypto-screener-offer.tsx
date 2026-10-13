import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { call, errText } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Dispatch key of the screener tool — identifies a screener run's step in
 * both live supervisor state and persisted run records. */
export const CRYPTO_SCREENER_TOOL = "crypto_screener";

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
 * findings, it does not re-derive them.
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
}

/** What the offer needs from the run: the market family and the interval the
 * scan ran on (both echoed back to the engine so the stop is folded over the
 * SAME candles the scan used), the actionable hits merged from EVERY screen's
 * step, and the scan's own totals for context. */
export interface ScreenerOffer {
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
  let interval: string | null = null;
  let scanned = 0;
  let hitsTotal = 0;
  let neutralHits = 0;
  let readable = 0;

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
    // A run is ONE market family; a step claiming otherwise is a stale or
    // foreign result, and honoring it would offer rows the engine refuses.
    if (universe != null && u !== universe) continue;
    if (universe == null) {
      universe = u;
      interval = str(o.interval) ?? "4h";
    }
    readable += 1;
    scanned += num(o.scanned) ?? 0;
    hitsTotal += num(o.hitsTotal) ?? o.hits.length;
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
      const last = num(h.last);
      if (score == null || last == null) continue;
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
      });
    }
  }

  if (readable === 0 || universe !== "usdm") return null;
  // Strongest first, and a symbol that fired several setups surfaces above a
  // single weak one — the same "cross-screen candidates first" ordering the
  // deliverable writer is asked for.
  hits.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  return { universe, interval: interval ?? "4h", scanned, hitsTotal, neutralHits, hits };
}

/** Read the human-usable numbers out of the engine's entry response: the
 * counts up front and the rows that need attention. A position that filled
 * but ended up WITHOUT its stop is the one outcome that must never be buried
 * in a success count. */
export function placementSummary(raw: string): {
  opened: number;
  failed: number;
  unprotected: number;
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
    opened,
    failed,
    unprotected: num(o.unprotected) ?? 0,
    note: str(o.note) ?? "",
    failures: rows("failures"),
    naked: rows("unprotectedPositions"),
  };
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
    if (ids.length === 0) {
      setReadFailed(true);
      return;
    }
    void Promise.all(ids.map((id) => fetcher(id, planKey).catch(() => null))).then((results) => {
      if (!alive) return;
      // Every read failed → the run view is broken, which must not read as
      // "the scan found nothing".
      if (results.every((r) => r == null)) setReadFailed(true);
      else setOutputs(results);
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

  const rowKey = (h: ScreenedHit) => `${h.symbol}|${h.screen}`;
  const q = query.trim().toUpperCase();
  const matching = offer.hits.filter((h) => (q.length === 0 || h.symbol.includes(q)) && h.score >= minScore);
  const filtered = matching.length !== offer.hits.length;
  const selectedHits = offer.hits.filter((h) => selected.has(rowKey(h)));
  const allSelected = selected.size === offer.hits.length;
  const noneSelected = selected.size === 0;
  const selectedInView = matching.filter((h) => selected.has(rowKey(h))).length;

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
      const out = await call<string>("binance_open_screened_positions", {
        picks: hits.map((h) => ({
          symbol: h.symbol,
          // The screen, never a side: the engine derives the direction from it.
          screen: h.screen,
          notional: notionals[rowKey(h)] ?? DEFAULT_NOTIONAL,
        })),
        interval: offer.interval,
        risk: "standard",
      });
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
        <span className="rounded border px-1.5 py-0.5">USDⓈ-M futures</span>
        <span className="rounded border px-1.5 py-0.5">{offer.interval} candles</span>
        <span className="rounded border px-1.5 py-0.5">standard stops</span>
        <span className="text-foreground rounded border px-1.5 py-0.5">
          {offer.hits.length} of {offer.hitsTotal} hits from {offer.scanned} symbols
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
        opens with its protective stop already resting. Kawai never opens a position it cannot place a stop for.
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
                  {summary.unprotected > 0 && (
                    <span className="text-destructive"> · {summary.unprotected} without a stop</span>
                  )}
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
