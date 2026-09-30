import { Icon } from "@/components/shared/icon";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import { type AssetViewId, ASSET_NAV } from "./asset-nav";

/**
 * The app's asset navigation — one entry per ASSET_NAV id, feature-gated by
 * backend availability (wallet needs the `monad` feature, code needs
 * `codegraph`). Rendered vertically in the mobile nav drawer (the profile
 * dropdown carries the same entries on larger screens, including inside the
 * asset workspace); the center-pane swap and its Esc/back behavior are owned
 * by app/App.tsx either way.
 */
export function AssetNavList({
  assetView,
  walletAvailable = true,
  codegraphAvailable = false,
  onSelectAsset,
  orientation = "horizontal",
  className,
}: {
  /** Open asset workspace (center pane replaces the workbench); null = workbench view. */
  assetView: AssetViewId | null;
  walletAvailable?: boolean;
  codegraphAvailable?: boolean;
  onSelectAsset: (id: AssetViewId) => void;
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <nav
      className={cn(
        "flex gap-1",
        orientation === "vertical" ? "flex-col" : "min-w-0 flex-row items-center overflow-x-auto py-1",
        className,
      )}
    >
      {ASSET_NAV.filter(
        (asset) => (asset.id !== "wallet" || walletAvailable) && (asset.id !== "code" || codegraphAvailable),
      ).map((asset) => {
        const active = assetView === asset.id;
        return (
          <button
            className={cn(
              "flex shrink-0 items-center rounded-lg text-left transition-colors",
              orientation === "vertical" ? "w-full gap-2.5 px-2.5 py-2" : "gap-2 px-2.5 py-1.5",
              active ? "bg-primary text-primary-foreground" : "hover:bg-[var(--tea-color-bg-secondary-default)]",
            )}
            key={asset.id}
            onClick={() => onSelectAsset(asset.id)}
            title={`${t(asset.labelKey)} · ${asset.subtitle}`}
            type="button"
          >
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center rounded-md",
                active ? "bg-background/20" : "bg-muted",
              )}
            >
              <Icon name={asset.icon} className="size-[15px]" />
            </span>
            <span className="text-sm leading-tight font-medium whitespace-nowrap">{t(asset.labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}
