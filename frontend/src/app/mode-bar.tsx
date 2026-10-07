import { Icon } from "@/components/shared/icon";
import { ProfileControls } from "@/features/agents/profile-controls";
import type { AssetViewId } from "@/features/assets/components/asset-nav";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import { APP_MODES, MODE_ICON, MODE_LABEL, type AppMode } from "./modes";

/** Segmented track + pill — the same vocabulary the generator's segmented
 *  controls use, spelled out here so the bar carries no dependency on a
 *  feature's internals. */
const TRACK = "inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5";

function pillClass(active: boolean): string {
  return cn(
    "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium whitespace-nowrap transition-colors",
    active ? "bg-background text-foreground shadow-sm dark:bg-input/30" : "text-muted-foreground hover:text-foreground",
  );
}

/**
 * The mode switcher itself. Split out from `ModeBar` so its markup contract is
 * testable on its own — the account cluster reads an external store that has no
 * server snapshot, so the full bar cannot be server-rendered.
 *
 * `active` is null while an ASSET page is open: an asset is a different axis
 * from a mode, and lighting up "Text" there would claim the Workbench is
 * showing when the Wiki is. The active pill renders inert with `aria-current`
 * so assistive tech can never be told two modes are current.
 */
export function ModePills({ active, onSelect }: { active: AppMode | null; onSelect: (mode: AppMode) => void }) {
  const { t } = useI18n();
  return (
    <nav aria-label={t("modeBar.modes")} className="min-w-0 flex-1 overflow-x-auto">
      <div className={TRACK}>
        {APP_MODES.map((mode) => {
          const label = t(MODE_LABEL[mode]);
          return mode === active ? (
            <span aria-current="page" className={cn(pillClass(true), "pointer-events-none")} key={mode}>
              <Icon className="size-4" name={MODE_ICON[mode]} />
              <span>{label}</span>
            </span>
          ) : (
            <button
              aria-label={label}
              className={pillClass(false)}
              key={mode}
              onClick={() => onSelect(mode)}
              title={label}
              type="button"
            >
              <Icon className="size-4" name={MODE_ICON[mode]} />
              <span>{label}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

/**
 * The app's global top bar — brand, the five modes, and the account cluster
 * (Saldo chip + avatar dropdown carrying assets, theme, language, sign-out).
 *
 * Modes replace the per-page lane tabs that used to sit inside every generator
 * form: the switcher is now in one place, above every surface, so the answer to
 * "what can I make here" never depends on which page loaded.
 */
export function ModeBar({
  active,
  assetView = null,
  codegraphAvailable = false,
  onLogout,
  onSelect,
  onSelectAsset,
  userId,
  walletAvailable = false,
}: {
  /** The mode the center pane is showing; null = an asset page is open. */
  active: AppMode | null;
  /** Currently open asset, so the dropdown's check mark and avatar dot agree
   *  with the pane on screen. */
  assetView?: AssetViewId | null;
  codegraphAvailable?: boolean;
  onLogout: () => void;
  onSelect: (mode: AppMode) => void;
  onSelectAsset: (id: AssetViewId) => void;
  userId: string | null;
  walletAvailable?: boolean;
}) {
  return (
    <header className="border-border bg-background flex h-12 shrink-0 items-center gap-3 border-b px-3">
      <span className="text-foreground flex shrink-0 items-center gap-1.5 text-sm font-semibold">
        <Icon className="text-primary size-4" name="zap" />
        <span className="hidden sm:inline">kawai</span>
      </span>
      <ModePills active={active} onSelect={onSelect} />
      <ProfileControls
        assetView={assetView}
        codegraphAvailable={codegraphAvailable}
        onLogout={onLogout}
        onSelectAsset={onSelectAsset}
        userId={userId}
        walletAvailable={walletAvailable}
      />
    </header>
  );
}
