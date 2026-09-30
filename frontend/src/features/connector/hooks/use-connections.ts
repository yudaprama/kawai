import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useOp } from "@/hooks/use-op";
import { useI18n } from "@/hooks/use-i18n";
import { call, errText } from "@/lib/api";
import { logWarn } from "@/lib/logger";
import { showErrorToast } from "@/lib/utils";
import type { Connection } from "../constants";

/**
 * Connector connection state over the kawai backend ops
 * (`connector_list_connections` / `connector_connect` / `connector_poll` /
 * `connector_disconnect`). Ported from the web SPA's `web/src/lib/connector.ts`
 * with TanStack Query swapped for the local `useOp` — mutations publish an
 * invalidation through a module-level bus, and live `useConnections` instances
 * refetch (the stand-in for query invalidation).
 */

// ── Invalidation bus ────────────────────────────────────────────────────────

type Listener = () => void;
const listeners = new Set<Listener>();

function invalidateConnections() {
  for (const l of listeners) l();
}

// ── List ────────────────────────────────────────────────────────────────────

/** The connection list plus a manual refetch (used after mutations elsewhere). */
export function useConnections(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  const listOp = useOp<Connection[]>("connector_list_connections", undefined, { enabled });
  // Keep a ref so the bus subscription stays stable across renders.
  const refetchRef = useRef(listOp.execute);
  refetchRef.current = listOp.execute;

  useEffect(() => {
    if (!enabled) return;
    const listener = () => void refetchRef.current();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [enabled]);

  return {
    connections: listOp.data ?? [],
    loading: listOp.loading,
    error: listOp.error,
    refetch: listOp.execute,
    setData: listOp.setData,
  };
}

// ── Connect (popup-sync + poll loop) ────────────────────────────────────────

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000;

// `Promise.withResolvers` needs lib es2024; the frontend tsconfig targets older.
function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface ConnectResult {
  connectionId: string;
  redirectUrl?: string;
}

/** Distinguishes user-cancel / timeout from real failures so toasts match. */
export type ConnectFailureKind = "cancelled" | "timeout" | "failed";

export class ConnectError extends Error {
  kind: ConnectFailureKind;
  constructor(kind: ConnectFailureKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

/**
 * Start an OAuth connect and poll until the connection is ACTIVE. The popup
 * MUST be opened synchronously in the click handler (browsers block popups
 * opened after an await); we then navigate it to the provider redirect URL and
 * poll the backend every 2s up to 120s (Composio's success page is
 * cross-origin, so polling is the portable signal). Resolves with the ACTIVE
 * connection, or `undefined` after toasting cancel/timeout/failure.
 */
export function useConnectorConnect() {
  const { t } = useI18n();
  const [pendingToolkit, setPendingToolkit] = useState<string | null>(null);

  const onConnect = useCallback(
    async (toolkit: string, label: string): Promise<Connection | undefined> => {
      const popup = window.open("about:blank", "connector-oauth", "width=560,height=720");
      setPendingToolkit(toolkit);
      try {
        const started = await call<ConnectResult>("connector_connect", { toolkit });
        if (started.redirectUrl) {
          if (popup) popup.location.href = started.redirectUrl;
          else window.open(started.redirectUrl, "_blank", "noopener");
        }

        const deadline = Date.now() + POLL_TIMEOUT_MS;
        let active: Connection | undefined;
        while (Date.now() < deadline) {
          await delay(POLL_INTERVAL_MS);
          const s = await call<Connection>("connector_poll", { connectionId: started.connectionId }).catch(() => null);
          if (s?.status === "ACTIVE") {
            active = s;
            break;
          }
          if (s?.status === "FAILED" || s?.status === "EXPIRED") {
            popup?.close();
            throw new ConnectError("failed", `connection ${s.status}`);
          }
          if (popup?.closed) {
            // The user may have closed the popup right after approving — one
            // final poll decides between success and cancellation.
            const final = await call<Connection>("connector_poll", { connectionId: started.connectionId }).catch(
              () => null,
            );
            if (final?.status === "ACTIVE") {
              active = final;
              break;
            }
            throw new ConnectError("cancelled", "Connect cancelled");
          }
        }
        if (!active) {
          popup?.close();
          throw new ConnectError("timeout", "Connect timed out");
        }
        popup?.close();
        toast.success(t("connections.toastConnected", { label }));
        return active;
      } catch (err) {
        const kind = err instanceof ConnectError ? err.kind : "failed";
        if (kind === "cancelled") {
          showErrorToast(t("connections.connectCancelled", { label }));
        } else if (kind === "timeout") {
          showErrorToast(t("connections.connectTimedOut", { label }));
        } else {
          logWarn("connector_connect", err);
          showErrorToast(`${t("connections.connectFailed", { label })} — ${errText(err)}`);
        }
        return undefined;
      } finally {
        setPendingToolkit(null);
        invalidateConnections();
      }
    },
    [t],
  );

  return { onConnect, pendingToolkit };
}

// ── Disconnect ──────────────────────────────────────────────────────────────

export function useDisconnect() {
  const { t } = useI18n();
  const [pendingId, setPendingId] = useState<string | null>(null);

  const disconnect = useCallback(
    async (connectionId: string, label: string): Promise<boolean> => {
      setPendingId(connectionId);
      try {
        await call<null>("connector_disconnect", { connectionId });
        toast.success(t("connections.toastDisconnected", { label }));
        return true;
      } catch (err) {
        logWarn("connector_disconnect", err);
        showErrorToast(`${t("connections.disconnectFailed", { label })} — ${errText(err)}`);
        return false;
      } finally {
        setPendingId(null);
        invalidateConnections();
      }
    },
    [t],
  );

  return { disconnect, pendingId };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Check if a toolkit has an ACTIVE connection. */
export function isToolkitConnected(connections: Connection[], toolkit: string): boolean {
  return connections.some((c) => c.app === toolkit && c.status === "ACTIVE");
}

/** Return the set of toolkit slugs that have an ACTIVE connection. */
export function connectedToolkits(connections: Connection[]): Set<string> {
  return new Set(connections.filter((c) => c.status === "ACTIVE").map((c) => c.app));
}

/**
 * Find the best matching connection for a toolkit. Prefers ACTIVE; falls back
 * to the first non-deleted row so the user can reconnect.
 */
export function connectionFor(connections: Connection[], toolkit: string): Connection | undefined {
  const matches = connections.filter((c) => c.app === toolkit && c.status !== "DELETED");
  if (matches.length === 0) return undefined;
  return matches.find((c) => c.status === "ACTIVE") ?? matches[0];
}
