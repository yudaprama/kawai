import { useMemo } from "react";
import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/hooks/use-i18n";
import { CONNECTOR_APPS } from "../constants";
import { isToolkitConnected, useConnections, useConnectorConnect } from "../hooks/use-connections";

/**
 * "Connect X to continue" affordance for flows that need a toolkits' tools
 * (ported from the web SPA's ConnectorConnectBanner). Detection uses the
 * authoritative client `useConnections()`. Renders one row per offered but
 * not-yet-connected app; renders nothing when every implicated app is already
 * connected.
 *
 * Exported for mounting inside tool flows (e.g. connector_find_tools output) —
 * deliberately NOT mounted anywhere yet.
 */
export function ConnectorConnectBanner({ toolkits }: { toolkits: string[] }) {
  const { t } = useI18n();
  const { connections } = useConnections();
  const { onConnect, pendingToolkit } = useConnectorConnect();

  const pending = useMemo(() => {
    const wanted = new Set(toolkits.map((s) => s.toLowerCase()));
    const seen = new Set<string>();
    const rows: (typeof CONNECTOR_APPS)[number][] = [];
    for (const a of CONNECTOR_APPS) {
      if (!wanted.has(a.toolkit) || seen.has(a.toolkit)) continue;
      seen.add(a.toolkit);
      if (!isToolkitConnected(connections, a.toolkit)) rows.push(a);
    }
    return rows;
  }, [toolkits, connections]);

  if (pending.length === 0) return null;

  return (
    <div className="space-y-2">
      {pending.map((a) => {
        const connecting = pendingToolkit === a.toolkit;
        return (
          <div
            className="flex items-center justify-between gap-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2"
            key={a.toolkit}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Icon className="size-4 shrink-0 text-warning" name="plug-zap" />
              <span className="truncate text-sm">{t("connections.connectToContinue", { label: a.label })}</span>
            </div>
            <Button disabled={connecting} onClick={() => void onConnect(a.toolkit, a.label)} size="sm">
              {connecting ? (
                <>
                  <Spinner className="size-4" /> {t("connections.connecting")}
                </>
              ) : (
                t("connections.connect")
              )}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
