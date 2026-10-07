import { Icon } from "@/components/shared/icon";
import { useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import { AssetChromeContext } from "./asset-chrome";
import { AssetNavList } from "./asset-nav-list";

/**
 * Shell for the center-pane workspace pages: an optional header (back
 * affordance + page title + an icon-only asset rail on lg+), then the page body
 * filling the remaining height (children own their scrolling — the asset split
 * layout scrolls internally). The account cluster lives one row up, in the
 * global mode bar, so it is identical here, on the Workbench, and in a lane.
 *
 * `bare` drops that header row. The media lanes use it: the mode bar directly
 * above already names the lane, one click on `Text` goes back, and Esc does
 * the same — so a page header there would only restate what is on screen.
 */
export function AssetShell({
  bare = false,
  title,
  subtitle,
  onBack,
  children,
}: {
  /** Render no header row at all (see `bare`). Title/rail are meaningless then. */
  bare?: boolean;
  title?: string;
  subtitle?: string;
  onBack?: () => void;
  children: ReactNode;
}) {
  const chrome = useContext(AssetChromeContext);
  const { t } = useI18n();
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(max-width: 1023px)");
    setIsMobile(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  return (
    <main className="bg-background flex min-w-0 flex-1 flex-col overflow-clip">
      {!bare && (
        <div className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
          {onBack && (
            <Button
              aria-label={t("assetNav.backToWorkbench")}
              onClick={onBack}
              size={isMobile ? "sm" : "icon"}
              variant={isMobile ? "outline" : "ghost"}
              className={cn("flex-shrink-0", isMobile && "min-w-[88px] justify-start gap-2 text-xs font-medium")}
              title={`${t("assetNav.backToWorkbench")} (Esc)`}
            >
              <Icon name="arrow-left" className="size-4" />
              {isMobile && <span>{t("assetNav.workbench")}</span>}
            </Button>
          )}
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold">{title}</h2>}
            {subtitle && <p className="text-muted-foreground truncate text-xs leading-tight">{subtitle}</p>}
          </div>
          {/* Persistent asset switcher (lg+): jumping between assets without a
              round trip through the avatar dropdown. Icon-only — eight
              labelled chips never fit a 48px row, and the mode bar above
              already spends the horizontal budget on the five modes. Below lg
              the nav drawer carries the same entries with labels. */}
          {chrome && !isMobile && (
            <div className="ml-auto hidden min-w-0 lg:block">
              <AssetNavList
                assetView={chrome.assetView}
                codegraphAvailable={chrome.codegraphAvailable}
                walletAvailable={chrome.walletAvailable}
                onSelectAsset={chrome.onSelectAsset}
                showLabels={false}
              />
            </div>
          )}
        </div>
      )}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">{children}</div>
    </main>
  );
}

/** Shared honest empty state for asset panes awaiting their backend tier. */
export function EmptyPane({ label, description, icon }: { label: string; description: string; icon: ReactNode }) {
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="bg-muted flex size-12 items-center justify-center rounded-lg">{icon}</div>
      <div className="space-y-1">
        <p className="text-foreground text-sm font-medium">{label}</p>
        <p className="max-w-md text-xs leading-relaxed">{description}</p>
      </div>
    </div>
  );
}
