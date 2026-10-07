import { Icon } from "@/components/shared/icon";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import { type AssetViewId, ASSET_NAV } from "./asset-nav";

/**
 * The app's asset navigation — one entry per ASSET_NAV id, feature-gated by
 * backend availability (wallet needs the `monad` feature, code needs
 * `codegraph`). Rendered as an icon rail in the asset page header and
 * vertically with labels in the mobile nav drawer; the avatar dropdown carries
 * the same entries everywhere. The center-pane swap and its Esc/back behavior
 * are owned by app/App.tsx either way.
 *
 * `showLabels={false}` is the header rail: eight labelled chips cannot fit a
 * 48px row beside a title and the mode bar, so the label moves into the
 * tooltip and the accessible name rather than disappearing.
 */
export function AssetNavList({
  assetView,
  walletAvailable = true,
  codegraphAvailable = false,
  onSelectAsset,
  orientation = "horizontal",
  showLabels = true,
  className,
}: {
  /** Open asset workspace (center pane replaces the workbench); null = workbench view. */
  assetView: AssetViewId | null;
  walletAvailable?: boolean;
  codegraphAvailable?: boolean;
  onSelectAsset: (id: AssetViewId) => void;
  orientation?: "horizontal" | "vertical";
  /** false = icon-only rail (the header); the label stays in `title` + aria-label. */
  showLabels?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <nav
      aria-label={showLabels ? undefined : t("assetNav.assets")}
      className={cn("flex gap-1", orientation === "vertical" ? "flex-col" : "min-w-0 flex-row items-center", className)}
    >
      {ASSET_NAV.filter(
        (asset) => (asset.id !== "wallet" || walletAvailable) && (asset.id !== "code" || codegraphAvailable),
      ).map((asset) => {
        const active = assetView === asset.id;
        const label = t(asset.labelKey);
        return (
          <button
            aria-label={showLabels ? undefined : label}
            className={cn(
              "flex shrink-0 items-center rounded-lg text-left transition-colors",
              orientation === "vertical" ? "w-full gap-2.5 px-2.5 py-2" : showLabels ? "gap-2 px-2.5 py-1.5" : "p-1",
              active ? "bg-primary text-primary-foreground" : "hover:bg-[var(--tea-color-bg-secondary-default)]",
            )}
            key={asset.id}
            aria-current={active ? "page" : undefined}
            onClick={() => onSelectAsset(asset.id)}
            title={`${label} · ${asset.subtitle}`}
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
            {showLabels && <span className="text-sm leading-tight font-medium whitespace-nowrap">{label}</span>}
          </button>
        );
      })}
    </nav>
  );
}
