import { useEffect } from "react";
import { toast } from "sonner";

import { Icon } from "@/components/shared/icon";
import type { AssetViewId } from "@/features/assets/components/asset-nav";
import { isLowTokenBalance, useTokenBalance } from "@/features/topup/use-token-balance";

/** One low-balance toast per app session — the chip itself goes quiet after
 *  that (the amber state keeps showing). */
let warnedThisSession = false;

/**
 * The app header's always-visible "Saldo" chip — the balance is readable
 * without opening the Top Up page (same shared store the goal-submit gate
 * consumes). Click opens the Top Up asset page; an amber state marks a
 * balance inside the low band.
 */
export function TokenBalanceChip({ onSelectAsset }: { onSelectAsset: (id: AssetViewId) => void }) {
  const { tokens, pending } = useTokenBalance();
  const low = isLowTokenBalance(tokens);

  useEffect(() => {
    if (!low || warnedThisSession) return;
    warnedThisSession = true;
    toast("Saldo token menipis — isi ulang lewat Top Up");
  }, [low]);

  const value = tokens === null ? (pending ? "…" : "—") : tokens.toLocaleString("id-ID");
  const label = `Saldo token: ${value} — buka Top Up`;

  return (
    <button
      aria-label={label}
      className={`mr-0.5 flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 transition-colors ${
        low ? "border-warning/40 text-warning hover:bg-warning/10" : "hover:bg-[var(--tea-color-bg-secondary-default)]"
      }`}
      onClick={() => onSelectAsset("topup")}
      title={low ? `${label} · saldo menipis` : label}
      type="button"
    >
      <Icon name="qr-code" className="size-4" />
      <span className="text-muted-foreground hidden text-xs md:inline">Saldo</span>
      <span className="font-mono text-xs font-medium tabular-nums">{value}</span>
    </button>
  );
}
