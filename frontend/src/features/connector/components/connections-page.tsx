import { useMemo, useState } from "react";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { AssetPageHeader } from "@/features/assets/components/asset/asset-page-header";
import { Icon } from "@/components/shared/icon";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/hooks/use-i18n";
import type { TranslationKey } from "@/lib/i18n";
import { useTheme } from "@/hooks/use-theme";
import { cn } from "@/lib/utils";
import { CONNECTOR_APPS, CONNECTOR_CATEGORIES, type ConnectorApp, type ConnectorCategory } from "../constants";
import type { ConnectorConnection } from "@/lib/api";
import { connectionFor, useConnections, useConnectorConnect, useDisconnect } from "../hooks/use-connections";

/**
 * Connections asset page — ported from the web SPA's ConnectionsTab: a "Your
 * connections" management strip (every Composio status is surfaced, not just
 * ACTIVE — collapsing the others to "Not connected" hid failed OAuth attempts
 * and offered no reconnect path), then a "Browse apps" catalog with category
 * chips + search. Apps with any connection row live only in "Your
 * connections", so the catalog shows apps the user hasn't added yet.
 */

const CATEGORY_LABEL_KEYS: Record<"all" | ConnectorCategory, TranslationKey> = {
  all: "connections.category.all",
  google: "connections.category.google",
  microsoft: "connections.category.microsoft",
  communication: "connections.category.communication",
  productivity: "connections.category.productivity",
  crm: "connections.category.crm",
  dev: "connections.category.dev",
  design: "connections.category.design",
};

const STATUS_META: Record<string, { dot: string; text: string; labelKey: TranslationKey }> = {
  ACTIVE: { dot: "bg-success", text: "text-success", labelKey: "connections.connected" },
  INITIALIZING: { dot: "bg-warning animate-pulse", text: "text-warning", labelKey: "connections.status.initializing" },
  EXPIRED: { dot: "bg-warning", text: "text-warning", labelKey: "connections.status.expired" },
  FAILED: { dot: "bg-destructive", text: "text-destructive", labelKey: "connections.status.failed" },
};

const STATUS_FALLBACK = {
  dot: "bg-muted-foreground/50",
  text: "text-muted-foreground",
  labelKey: "connections.status.notConnected" as TranslationKey,
};

function StatusBadge({ status }: { status?: string }) {
  const { t } = useI18n();
  const cfg = (status && STATUS_META[status]) || STATUS_FALLBACK;
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium", cfg.text)}>
      <span aria-hidden className={cn("size-1.5 rounded-full", cfg.dot)} />
      {t(cfg.labelKey)}
    </span>
  );
}

function AppLogo({ toolkit, label }: { toolkit: string; label: string }) {
  const { resolvedTheme } = useTheme();
  return (
    <img
      alt={label}
      className="size-5 shrink-0"
      height={20}
      loading="lazy"
      src={`https://logos.composio.dev/api/${toolkit}?theme=${resolvedTheme}`}
      width={20}
    />
  );
}

function AppCard({
  app,
  connection,
  children,
}: {
  app: ConnectorApp;
  connection?: ConnectorConnection;
  children: React.ReactNode;
}) {
  return (
    <Card className="py-0">
      <CardContent className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="flex min-w-0 items-center gap-3">
          <AppLogo label={app.label} toolkit={app.toolkit} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{app.label}</div>
            {connection ? <StatusBadge status={connection.status} /> : <StatusBadge />}
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

export function ConnectionsPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const { connections, loading, error, refetch } = useConnections();
  const { onConnect, pendingToolkit } = useConnectorConnect();
  const { disconnect, pendingId } = useDisconnect();

  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"all" | ConnectorCategory>("all");

  // Apps with any non-DELETED row — the "Your connections" management surface.
  const yourApps = useMemo(
    () => CONNECTOR_APPS.filter((a) => connections.some((c) => c.app === a.toolkit && c.status !== "DELETED")),
    [connections],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const hasConnection = (toolkit: string) => connections.some((c) => c.app === toolkit && c.status !== "DELETED");
    return CONNECTOR_APPS.filter((a) => {
      if (hasConnection(a.toolkit)) return false;
      if (category !== "all" && a.category !== category) return false;
      if (q && !a.label.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => a.label.localeCompare(b.label));
  }, [query, category, connections]);

  const renderActionButton = (a: ConnectorApp) => {
    const conn = connectionFor(connections, a.toolkit);
    const status = conn?.status;
    const activeConn = status === "ACTIVE" && conn ? conn : undefined;
    const isStale = status === "EXPIRED" || status === "FAILED";
    const connecting = pendingToolkit === a.toolkit;
    const removing = pendingId != null && pendingId === conn?.id;
    const connectLabel = isStale
      ? t("connections.reconnect")
      : status === "INITIALIZING"
        ? t("connections.resume")
        : t("connections.connect");

    if (activeConn) {
      return (
        <Button disabled={removing} onClick={() => void disconnect(activeConn.id, a.label)} size="sm" variant="outline">
          {removing ? <Spinner className="size-4" /> : t("connections.disconnect")}
        </Button>
      );
    }
    return (
      <Button disabled={connecting} onClick={() => void onConnect(a.toolkit, a.label)} size="sm">
        {connecting ? (
          <>
            <Spinner className="size-4" /> {isStale ? t("connections.reconnecting") : t("connections.connecting")}
          </>
        ) : (
          connectLabel
        )}
      </Button>
    );
  };

  const grid = (apps: readonly ConnectorApp[]) => (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {apps.map((a) => (
        <AppCard connection={connectionFor(connections, a.toolkit)} key={a.toolkit} app={a}>
          {renderActionButton(a)}
        </AppCard>
      ))}
    </div>
  );

  const showSkeleton = loading && connections.length === 0;

  return (
    <AssetShell subtitle={t("connections.subtitle")} title={t("connections.title")} onBack={onBack}>
      <AssetPageHeader subtitle={t("connections.intro")} title={t("connections.title")} />

      {error != null && connections.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center gap-3 py-10 text-center text-sm">
          <p>
            {t("common.error")}: {error}
          </p>
          <Button onClick={() => void refetch()} size="sm" variant="outline">
            {t("common.retry")}
          </Button>
        </div>
      ) : showSkeleton ? (
        <div aria-busy className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {["s0", "s1", "s2", "s3", "s4", "s5"].map((k) => (
            <Card key={k} className="py-0">
              <CardContent className="flex items-center gap-3 px-3 py-2">
                <Skeleton className="size-5 rounded" />
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3.5 w-24" />
                  <Skeleton className="h-3 w-40" />
                </div>
                <Skeleton className="h-8 w-20" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="mt-4 flex flex-col gap-6">
          {yourApps.length > 0 && (
            <section className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <h2 className="text-sm font-semibold">{t("connections.yourConnections")}</h2>
                <Badge className="tabular-nums" variant="secondary">
                  {yourApps.length}
                </Badge>
              </div>
              {grid(yourApps)}
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h2 className="flex items-center gap-1.5 text-sm font-semibold">
              <Icon className="size-4" name="plug-zap" />
              {t("connections.browse")}
            </h2>
            <div className="flex flex-wrap items-center gap-1.5">
              {(["all", ...CONNECTOR_CATEGORIES] as const).map((c) => (
                <button
                  className={cn(
                    "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                    category === c
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )}
                  key={c}
                  onClick={() => setCategory(c)}
                  type="button"
                >
                  {t(CATEGORY_LABEL_KEYS[c])}
                </button>
              ))}
            </div>
            <Input
              className="max-w-xs"
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("connections.searchPlaceholder")}
              type="search"
              value={query}
            />
            {filtered.length === 0 ? (
              <p className="text-muted-foreground py-10 text-center text-sm">
                {query.trim() ? t("connections.emptySearch", { query: query.trim() }) : t("connections.emptyCatalog")}
              </p>
            ) : (
              grid(filtered)
            )}
          </section>
        </div>
      )}
    </AssetShell>
  );
}
