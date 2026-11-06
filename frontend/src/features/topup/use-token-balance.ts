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
 *   - the Top Up page re-reads right after a voucher is redeemed;
 *   - window focus re-reads at most once per `FOCUS_REFRESH_MS`.
 *
 * This store is DISPLAY-ONLY. The authoritative gates are the client pre-check
 * in `use-workbench.run()` and the fail-closed server gate in
 * `supervisor::plan_task` — both do their own read.
 */
import { useEffect, useSyncExternalStore } from "react";

import { call, type TopupBalance } from "@/lib/api";

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

/**
 * Offline snapshot TTL — MIRRORS `OFFLINE_BALANCE_TTL_SECS` (6 h) in
 * `kawai/src-tauri/src/logic/topup.rs`. A snapshot older than this is not
 * offered to the submit gate (the backend gate would reject it as stale
 * anyway; skipping the RPC would only show a toast that lies).
 */
export const OFFLINE_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;

const PERSIST_KEY_PREFIX = "kawai:token-balance";

interface PersistedBalance {
  tokens: number;
  /** Epoch ms of the successful read that wrote it. */
  at: number;
}

/**
 * Owner scope of the persisted snapshot. kawai-web serves many accounts from
 * one browser profile — an unscoped key would let account A's balance gate
 * account B's offline submits after a logout/login switch. Called by the auth
 * bootstrap (use-supervisor-chat) as soon as the session identity is known.
 * Per-owner keys also preserve each account's own snapshot across switches.
 */
let ownerScope = "shared";

function persistKey(): string {
  return `${PERSIST_KEY_PREFIX}:${ownerScope}`;
}

export function setTokenBalanceOwner(user: string): void {
  const scope = user.trim().toLowerCase() || "shared";
  if (scope === ownerScope) return;
  ownerScope = scope;
  // The in-memory store belongs to the previous owner — reset it so the chip
  // never renders another account's number. The persisted snapshots are
  // per-owner keys and stay.
  snapshot = { tokens: null, pending: false };
  lastReadAt = 0;
  for (const listener of listeners) listener();
}

function persistBalance(tokens: number): void {
  const next: PersistedBalance = { tokens, at: Date.now() };
  try {
    window.localStorage.setItem(persistKey(), JSON.stringify(next));
  } catch {
    // Private-mode/quota failures lose only the offline fallback.
  }
}

function readPersistedBalance(): PersistedBalance | null {
  try {
    const raw = window.localStorage.getItem(persistKey());
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as PersistedBalance).tokens === "number" &&
      typeof (parsed as PersistedBalance).at === "number"
    ) {
      return parsed as PersistedBalance;
    }
  } catch {
    // Corrupt entry = no snapshot.
  }
  return null;
}

/**
 * Last successful balance persisted across restarts — the submit gate's
 * OFFLINE fallback. Display-only persistence: the authoritative offline
 * decision is the server gate in `supervisor::plan_task` (cached snapshot +
 * ledger grace), so a stale-positive snapshot here degrades to a server
 * rejection, never unbilled usage.
 */
export function peekPersistedTokenBalance(maxAgeMs: number = OFFLINE_SNAPSHOT_TTL_MS): PersistedBalance | null {
  const snap = readPersistedBalance();
  if (!snap || snap.tokens <= 0 || Date.now() - snap.at > maxAgeMs) return null;
  return snap;
}

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
  // Scope at read START: an account switch while the read is in flight must
  // not land the PREVIOUS owner's balance in the new owner's store.
  const scope = ownerScope;
  inflight = call<TopupBalance>("topup_balance")
    .then(({ tokens }) => {
      if (ownerScope !== scope) return null;
      lastReadAt = Date.now();
      publish({ tokens, pending: false });
      persistBalance(tokens);
      return tokens;
    })
    .catch(() => {
      if (ownerScope !== scope) return null;
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
 * Fresh cached balance without a network read — lets the submit gate skip its
 * RPC when the chip/page already read recently. `null` = no fresh value, do
 * the read. The server-side gate inside `plan_task` stays authoritative, so a
 * stale-positive cache degrades to a server rejection, never unbilled usage.
 */
export function peekFreshTokenBalance(maxAgeMs: number = FOCUS_REFRESH_MS): number | null {
  if (snapshot.tokens == null || Date.now() - lastReadAt > maxAgeMs) return null;
  return snapshot.tokens;
}

/**
 * Publish a balance the caller ALREADY read. `persist` stays true only for
 * values that came from a real worker read — optimistic estimates (a media
 * debit subtracted locally) and re-published offline snapshots must NOT
 * re-stamp the snapshot's freshness, or a hours-old read stays "fresh"
 * indefinitely and stretches the documented TTL.
 */
export function publishTokenBalance(tokens: number, persist = true): void {
  lastReadAt = Date.now();
  publish({ tokens, pending: false });
  if (persist) persistBalance(tokens);
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
