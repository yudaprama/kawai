/**
 * Shared app-token balance (Fase 0a/0b, PLAN-qris-topup.md) — ONE read path
 * for the whole frontend: the rail's balance chip, the Top Up page and the
 * goal-submit gate all consume this store instead of issuing independent
 * `topup_balance` reads.
 *
 * Refreshes are EVENT-DRIVEN, never polled — the balance only changes when a
 * run debits it (Fase 0b, inside `plan_task`), when a QRIS claim is credited,
 * or when an admin credits it:
 *   - first subscriber (app start) reads once;
 *   - the submit gate publishes the value it already read (pre-debit);
 *   - `use-workbench` re-reads right after `plan_task` resolves (post-debit);
 *   - the Top Up page re-reads when a claim turns `credited`;
 *   - window focus re-reads at most once per `FOCUS_REFRESH_MS`.
 *
 * This store is DISPLAY-ONLY. The authoritative gates are the client pre-check
 * in `use-workbench.run()` and the fail-closed server gate in
 * `supervisor::plan_task` — both do their own read.
 */
import { useEffect, useSyncExternalStore } from "react";

import { call } from "@/lib/api";

/**
 * Low-balance warning threshold = 10% of the SMALLEST possible top-up —
 * `MIN_BASE` 10_000 × `TOKENS_PER_IDR` 100 in
 * `kawai-server/worker/src/qris.ts` (= 1_000_000 tokens). A run debits the
 * planner's real input+output usage against this balance, so under this
 * value the next runs risk tripping the zero gate mid-flight. Hardcoded on
 * purpose (repo rule: no new env knobs) — keep in sync with `qris.ts`.
 */
export const LOW_BALANCE_TOKENS = 100_000;

/** Focus re-reads only when the last SUCCESSFUL read is at least this old. */
const FOCUS_REFRESH_MS = 30_000;

export interface TokenBalanceSnapshot {
  /** `null` = never read or unreadable → renders as "…"/"—". */
  tokens: number | null;
  /** A read is in flight. */
  pending: boolean;
}

let snapshot: TokenBalanceSnapshot = { tokens: null, pending: false };
let lastReadAt = 0;
let inflight: Promise<number | null> | null = null;
const listeners = new Set<() => void>();

const getSnapshot = () => snapshot;

function publish(next: Partial<TokenBalanceSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) listener();
}

function subscribe(onStoreChange: () => void): () => void {
  listeners.add(onStoreChange);
  return () => listeners.delete(onStoreChange);
}

/**
 * Read the shared balance. Concurrent callers share ONE in-flight read, so a
 * chip + page + gate mounting together cost a single request. Never cached
 * beyond that — a caller that asks gets a fresh answer. A failed read keeps
 * the last known value (a transient worker hiccup must not blank a working
 * display) and resolves `null` for callers that need to distinguish.
 */
export function refreshTokenBalance(): Promise<number | null> {
  if (inflight) return inflight;
  publish({ pending: true });
  inflight = call<{ tokens: number }>("topup_balance")
    .then(({ tokens }) => {
      lastReadAt = Date.now();
      publish({ tokens, pending: false });
      return tokens;
    })
    .catch(() => {
      // Display-only: keep the last known tokens, just clear `pending`.
      publish({ pending: false });
      return null;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

/**
 * Publish a balance the caller ALREADY read — the goal-submit gate's
 * pre-check doubles as the store's freshest pre-debit value for free.
 */
export function publishTokenBalance(tokens: number): void {
  lastReadAt = Date.now();
  publish({ tokens, pending: false });
}

/** Amber-warning band: a positive balance too small to be comfortable. */
export function isLowTokenBalance(tokens: number | null): boolean {
  return tokens !== null && tokens > 0 && tokens < LOW_BALANCE_TOKENS;
}

/**
 * Subscribe a component to the shared balance. Reads once on mount and
 * re-reads on window focus (rate-limited by `FOCUS_REFRESH_MS`).
 */
export function useTokenBalance(): TokenBalanceSnapshot {
  const snap = useSyncExternalStore(subscribe, getSnapshot);
  useEffect(() => {
    void refreshTokenBalance();
    const onFocus = () => {
      if (Date.now() - lastReadAt >= FOCUS_REFRESH_MS) void refreshTokenBalance();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
  return snap;
}
