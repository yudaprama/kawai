import { useEffect } from "react";
import { toast } from "sonner";

import { Icon } from "@/components/shared/icon";
import type { AssetViewId } from "@/features/assets/components/asset-nav";
import { isLowTokenBalance, useTokenBalance } from "@/features/topup/use-token-balance";
import { useI18n } from "@/hooks/use-i18n";

/** One low-balance toast per app session — the chip itself goes quiet after
 *  that (the amber state keeps showing). */
let warnedThisSession = false;

/**
 * The app header's always-visible balance chip — the balance is readable
 * without opening the Top Up page (same shared store the goal-submit gate
 * consumes). Click opens the Top Up asset page; an amber state marks a
 * balance inside the low band.
 */
export function TokenBalanceChip({ onSelectAsset }: { onSelectAsset: (id: AssetViewId) => void }) {
  const { t, fmtNumber } = useI18n();
  const { tokens, pending } = useTokenBalance();
  const low = isLowTokenBalance(tokens);

  useEffect(() => {
    if (!low || warnedThisSession) return;
    warnedThisSession = true;
    toast(t("topup.chip.lowToast"));
  }, [low, t]);

  const value = tokens === null ? (pending ? "…" : "—") : fmtNumber(tokens);
  const label = t("topup.chip.openAria", { value });

  return (
    <button
      aria-label={label}
      className={`mr-0.5 flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 transition-colors ${
        low ? "border-warning/40 text-warning hover:bg-warning/10" : "hover:bg-[var(--tea-color-bg-secondary-default)]"
      }`}
      onClick={() => onSelectAsset("topup")}
      title={low ? `${label} · ${t("topup.chip.lowSuffix")}` : label}
      type="button"
    >
      {/* Icon stays md+ only (narrow phones); the balance word is ALWAYS
          visible — a bare number read as a cryptic counter, and unlike the
          icon the word costs ~30px, not the mode bar's whole overflow. */}
      <Icon name="qr-code" className="hidden size-4 md:inline" />
      <span className="text-muted-foreground text-xs">{t("topup.chip.label")}</span>
      <span className="font-mono text-xs font-medium tabular-nums">{value}</span>
    </button>
  );
}
