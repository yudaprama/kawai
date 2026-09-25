import { useEffect } from "react";
import { toast } from "sonner";

import { Icon } from "@/components/shared/icon";
import type { AssetViewId } from "@/features/assets/components/asset-nav";
import { isLowTokenBalance, useTokenBalance } from "@/features/topup/use-token-balance";

/** One low-balance toast per app session — the chip itself goes quiet after
 *  that (the amber state keeps showing). */
let warnedThisSession = false;

/**
 * The rail's always-visible "Saldo token" chip — the balance is readable
 * without opening the Top Up page. Click opens the Top Up asset page; an
 * amber state marks a balance inside the low band. Collapsed rails get the
 * icon-only form so it still fits the 64px rail.
 */
export function TokenBalanceChip({
  collapsed,
  onSelectAsset,
}: {
  collapsed: boolean;
  onSelectAsset: (id: AssetViewId) => void;
}) {
  const { tokens, pending } = useTokenBalance();
  const low = isLowTokenBalance(tokens);

  useEffect(() => {
    if (!low || warnedThisSession) return;
    warnedThisSession = true;
    toast("Saldo token menipis — isi ulang lewat Top Up");
  }, [low]);

  const value = tokens === null ? (pending ? "…" : "—") : tokens.toLocaleString("id-ID");
  const label = `Saldo token: ${value} — buka Top Up`;

  if (collapsed) {
    return (
      <div className="px-1.5 pb-1.5">
        <button
          aria-label={label}
          className={`flex w-full items-center justify-center rounded-lg border p-2 transition-colors ${
            low ? "border-amber-500/40 hover:bg-amber-500/10" : "hover:bg-[var(--tea-color-bg-secondary-default)]"
          }`}
          onClick={() => onSelectAsset("topup")}
          title={label}
          type="button"
        >
          <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-lg">
            <Icon name="qr-code" className="size-[15px]" />
          </span>
        </button>
      </div>
    );
  }

  return (
    <div className="px-2 pb-1.5">
      <button
        className={`flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors ${
          low ? "border-amber-500/40 hover:bg-amber-500/10" : "hover:bg-[var(--tea-color-bg-secondary-default)]"
        }`}
        onClick={() => onSelectAsset("topup")}
        title={low ? `${label} · saldo menipis` : label}
        type="button"
      >
        <span className="bg-muted flex size-7 shrink-0 items-center justify-center rounded-lg">
          <Icon name="qr-code" className="size-[15px]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-muted-foreground text-[11px] leading-tight">Saldo token</span>
          <span
            className={`truncate font-mono text-sm leading-tight font-medium tabular-nums ${
              low ? "text-amber-500" : ""
            }`}
          >
            {value}
          </span>
        </span>
        {low && (
          <span className="text-amber-500 shrink-0 text-[10px] font-medium tracking-wide uppercase">menipis</span>
        )}
      </button>
    </div>
  );
}
