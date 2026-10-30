import { useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTitle } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { useI18n } from "@/hooks/use-i18n";
import { useTheme } from "@/hooks/use-theme";
import { AssetChromeContext } from "@/features/assets/components/asset-chrome";
import type { AssetViewId } from "@/features/assets/components/asset-nav";
import { CONNECTOR_APPS } from "../constants";
import { isToolkitConnected, useConnections, useConnectorConnect } from "../hooks/use-connections";
import type { ConnectorConnection } from "@/lib/api";

/**
 * Persistent connections affordance in the composer toolbar — ported from the
 * web SPA's ComposerConnections. The trigger is always visible (plug icon) and,
 * once the user has connected something, carries a small count so the state is
 * legible at a glance. The panel offers one-click connect per app (the same
 * OAuth-popup hook as the Connections page) plus a "Manage all" jump to the
 * Connections asset page. Detection + mutation are the authoritative client
 * hooks, so this stays in sync with the page and the inline banner.
 *
 * Surface follows the viewport: an anchored popover at lg+, a BOTTOM SHEET
 * below it — a centered floating panel is a desktop pattern; on a phone the
 * sheet is the thumb-reachable, scrim-dismissable convention. The trigger
 * button is a single stable element with controlled open state; only the
 * OVERLAY root swaps with the viewport. Never branch-swap Radix roots around
 * shared JSX elements — that crashed the subtree the moment a phone rotated
 * across the lg breakpoint.
 *
 * kawai has no guest surface (AuthGate wraps the whole app), so the button is
 * always shown.
 */

/** Shared panel content — a component (not a hoisted element) so each branch
 *  renders a fresh tree and the Dialog/Popover swap can never reconcile one
 *  element object across two different Radix roots. The title and description
 *  are SLOTS: Radix's DialogTitle throws outside a Dialog root, so the sheet
 *  branch passes the dialog primitives and the popover branch passes plain
 *  elements. */
function ConnectionsPanel({
  query,
  onQuery,
  resolvedTheme,
  chrome,
  pendingToolkit,
  onConnect,
  connections,
  sheet,
  title,
  description,
}: {
  query: string;
  onQuery: (q: string) => void;
  resolvedTheme: string;
  chrome: { onSelectAsset: (id: AssetViewId) => void } | null;
  pendingToolkit: string | null;
  onConnect: (toolkit: string, label: string) => Promise<unknown>;
  connections: ConnectorConnection[];
  sheet: boolean;
  title: ReactNode;
  description: ReactNode;
}) {
  const { t } = useI18n();
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CONNECTOR_APPS;
    return CONNECTOR_APPS.filter((a) => a.label.toLowerCase().includes(q));
  }, [query]);

  return (
    <>
      <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="text-primary size-4" name="plug-zap" />
          {title}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
          {sheet && (
            <DialogClose asChild={true}>
              <Button aria-label={t("common.close")} className="size-7" size="icon" variant="ghost">
                <Icon className="size-3.5" name="x" />
              </Button>
            </DialogClose>
          )}
        </div>
      </div>

      {description}

      <div className="px-1.5 pt-1.5">
        <Input
          className="h-9"
          onChange={(e) => onQuery(e.target.value)}
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
    </>
  );
}

export function ComposerConnections() {
  const { t } = useI18n();
  const { resolvedTheme } = useTheme();
  const chrome = useContext(AssetChromeContext);
  const { connections } = useConnections();
  const { onConnect, pendingToolkit } = useConnectorConnect();

  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  // Below lg the panel renders as a sheet (see the component doc); the
  // listener keeps the surface honest across rotation/resize. Controlled
  // `open` lives HERE, so a flip while the panel is open reopens the same
  // panel on the other root instead of fighting Radix's uncontrolled state.
  const [sheet, setSheet] = useState(
    () => typeof window === "undefined" || !window.matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const onChange = () => setSheet(!mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const connectedCount = CONNECTOR_APPS.filter((a) => isToolkitConnected(connections, a.toolkit)).length;
  const triggerLabel = connectedCount > 0 ? `${t("connections.title")} · ${connectedCount}` : t("connections.title");

  const panel = (
    <ConnectionsPanel
      chrome={chrome}
      connections={connections}
      description={
        sheet ? (
          <DialogDescription className="text-muted-foreground px-3 pt-2 text-xs">
            {t("connections.composer.hint")}
          </DialogDescription>
        ) : (
          <p className="text-muted-foreground px-3 pt-2 text-xs">{t("connections.composer.hint")}</p>
        )
      }
      onConnect={onConnect}
      onQuery={setQuery}
      pendingToolkit={pendingToolkit}
      query={query}
      resolvedTheme={resolvedTheme}
      sheet={sheet}
      title={
        sheet ? (
          <DialogTitle className="truncate text-sm font-medium">{t("connections.title")}</DialogTitle>
        ) : (
          <PopoverTitle className="truncate text-sm font-medium">{t("connections.title")}</PopoverTitle>
        )
      }
    />
  );

  return (
    <>
      <Button
        aria-label={triggerLabel}
        className="hit-44 relative size-8 text-muted-foreground [&_svg]:size-4"
        onClick={() => setOpen(true)}
        size="icon"
        title={triggerLabel}
        type="button"
        variant="ghost"
      >
        <Icon name="plug-zap" />
        {connectedCount > 0 && (
          <span className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full text-[0.625rem] font-medium tabular-nums">
            {connectedCount}
          </span>
        )}
      </Button>
      {sheet ? (
        <Dialog onOpenChange={setOpen} open={open}>
          <DialogContent
            className="inset-x-0 bottom-0 top-auto left-0 max-h-[85dvh] w-full max-w-none translate-x-0 translate-y-0 gap-0 overflow-y-auto rounded-b-none rounded-t-2xl border-b-0 p-0 pb-[env(safe-area-inset-bottom,0px)] sm:max-w-none data-[state=closed]:slide-out-to-bottom-6 data-[state=open]:slide-in-from-bottom-6"
            showCloseButton={false}
          >
            {/* Drag-handle affordance: visual shorthand for "this is a sheet,
                swipe/scrim/Esc dismiss it" — no drag JS, the exits above work. */}
            <div aria-hidden className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/30" />
            {panel}
          </DialogContent>
        </Dialog>
      ) : (
        <Popover onOpenChange={setOpen} open={open}>
          {/* Anchor, not Trigger: the plain button above owns opening — this
              only pins the popover's position to the icon. */}
          <PopoverAnchor asChild={true}>
            <span className="inline-flex" />
          </PopoverAnchor>
          <PopoverContent align="start" className="w-80 p-0" side="top">
            {panel}
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}
