import { useContext, useMemo, useState } from "react";
import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/hooks/use-i18n";
import { useTheme } from "@/hooks/use-theme";
import { AssetChromeContext } from "@/features/assets/components/asset-chrome";
import { CONNECTOR_APPS } from "../constants";
import { isToolkitConnected, useConnections, useConnectorConnect } from "../hooks/use-connections";

/**
 * Persistent connections affordance in the composer toolbar — ported from the
 * web SPA's ComposerConnections. The trigger is always visible (plug icon) and,
 * once the user has connected something, carries a small count so the state is
 * legible at a glance. The popover offers one-click connect per app (the same
 * OAuth-popup hook as the Connections page) plus a "Manage all" jump to the
 * Connections asset page. Detection + mutation are the authoritative client
 * hooks, so this stays in sync with the page and the inline banner.
 *
 * kawai has no guest surface (AuthGate wraps the whole app), so the button is
 * always shown.
 */
export function ComposerConnections() {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const chrome = useContext(AssetChromeContext);
  const { connections } = useConnections();
  const { onConnect, pendingToolkit } = useConnectorConnect();

  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CONNECTOR_APPS;
    return CONNECTOR_APPS.filter((a) => a.label.toLowerCase().includes(q));
  }, [query]);

  const connectedCount = CONNECTOR_APPS.filter((a) => isToolkitConnected(connections, a.toolkit)).length;

  return (
    <Popover>
      <PopoverTrigger asChild={true}>
        <Button
          aria-label={t("connections.title")}
          className="hit-44 relative size-8 text-muted-foreground [&_svg]:size-4"
          size="icon"
          title={t("connections.title")}
          type="button"
          variant="ghost"
        >
          <Icon name="plug-zap" />
          {connectedCount > 0 && (
            <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full text-[10px] font-medium tabular-nums">
              {connectedCount}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" side="top">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <div className="flex items-center gap-2">
            <Icon className="text-primary size-4" name="plug-zap" />
            <span className="text-sm font-medium">{t("connections.title")}</span>
          </div>
          {chrome && (
            <Button
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => chrome.onSelectAsset("connections")}
              size="sm"
              variant="ghost"
            >
              {t("connections.composer.manageAll")}
              <Icon className="size-3" name="arrow-right" />
            </Button>
          )}
        </div>

        <p className="text-muted-foreground px-3 pt-2 text-xs">{t("connections.composer.hint")}</p>

        <div className="px-1.5 pt-1.5">
          <Input
            className="h-8 text-sm"
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("connections.searchPlaceholder")}
            type="search"
            value={query}
          />
        </div>

        <div className="max-h-72 space-y-0.5 overflow-y-auto p-1.5">
          {filtered.length === 0 ? (
            <p className="text-muted-foreground px-2 py-6 text-center text-xs">
              {t("connections.emptySearch", { query: query.trim() })}
            </p>
          ) : (
            filtered.map((a) => {
              const isActive = isToolkitConnected(connections, a.toolkit);
              const connecting = pendingToolkit === a.toolkit;
              return (
                <div className="hover:bg-muted/50 flex items-center gap-2.5 rounded-md px-2 py-1.5" key={a.toolkit}>
                  <img
                    alt={a.label}
                    className="size-5 shrink-0"
                    loading="lazy"
                    src={`https://logos.composio.dev/api/${a.toolkit}?theme=${resolvedTheme}`}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{a.label}</span>
                  {isActive ? (
                    <span className="text-success text-xs font-medium">{t("connections.connected")}</span>
                  ) : (
                    <Button
                      className="h-7 px-2.5 text-xs"
                      disabled={connecting}
                      onClick={() => void onConnect(a.toolkit, a.label)}
                      size="sm"
                      variant="outline"
                    >
                      {connecting ? <Spinner className="size-3.5" /> : t("connections.connect")}
                    </Button>
                  )}
                </div>
              );
            })
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
