import { Icon } from "@/components/shared/icon";
import { EdgeFades, useXOverflow } from "@/components/shared/edge-fades";
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
    "hit-44 flex min-h-7 items-center gap-1.5 rounded-md px-1.5 lg:px-2.5 text-xs font-medium whitespace-nowrap transition-colors max-md:min-h-8",
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
 *
 * Labels render at `lg+` only — below that the pills collapse to icons
 * (accessible name + tooltip stay), so the five-pill track (~166px) always
 * fits between the brand and the account cluster and the bar never scrolls.
 * `lg` not `md` because the labeled track is ~495px wide: at the old `md`
 * cutoff the leftover space was exactly the track width, and Inter's metrics
 * (wider than the measured fallback font) tipped it into overflow. At `lg`
 * the headroom is ~250px. The `overflow-x-auto` nav + `EdgeFades` remain as
 * the sub-360px fallback: fades appear only when something is actually
 * clipped.
 */
export function ModePills({ active, onSelect }: { active: AppMode | null; onSelect: (mode: AppMode) => void }) {
  const { t } = useI18n();
  const { ref, showStart, showEnd } = useXOverflow<HTMLElement>();
  return (
    <div className="relative min-w-0 flex-1">
      {/* py/pr give the hit-44 ::after overlays (inset -6px) room INSIDE the
          scroller: overflow-x auto forces overflow-y to auto too, and without
          this padding the overlays put every viewport 6px into vertical
          scrollable overflow — a permanent scroll indicator on the bar. Left
          padding is unneeded: scrollable overflow only accrues to the right
          (and bottom), the first pill's left overhang is not scrollable.
          gap-2 above reclaims the rest of the sub-lg width budget. */}
      <nav aria-label={t("modeBar.modes")} className="overflow-x-auto py-2 pr-1.5" ref={ref}>
        <div className={TRACK}>
          {APP_MODES.map((mode) => {
            const label = t(MODE_LABEL[mode]);
            return mode === active ? (
              <span aria-current="page" className={cn(pillClass(true), "pointer-events-none")} key={mode}>
                <Icon className="size-4" name={MODE_ICON[mode]} />
                {/* The active mode keeps its label visible below lg — Android
                    never surfaces `title`, so an icon-only active pill is an
                    unnamed state on a phone. Inactive pills stay icons (their
                    labels arrive on tap). */}
                <span className="hidden max-lg:inline lg:inline">{label}</span>
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
                <span className="hidden lg:inline">{label}</span>
              </button>
            );
          })}
        </div>
      </nav>
      <EdgeFades showEnd={showEnd} showStart={showStart} />
    </div>
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
    <header className="border-border bg-background flex min-h-12 shrink-0 items-center gap-2 border-b px-3 lg:gap-3">
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
