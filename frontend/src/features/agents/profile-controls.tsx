import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { type AssetViewId, ASSET_NAV } from "@/features/assets/components/asset-nav";
import { type Theme, useTheme } from "@/hooks/use-theme";
import { TokenBalanceChip } from "@/features/topup/token-balance-chip";

function ThemeItems() {
  const { theme, setTheme } = useTheme();
  const options: { value: Theme; label: string; icon: string }[] = [
    { value: "light", label: "Light", icon: "sun" },
    { value: "dark", label: "Dark", icon: "moon" },
    { value: "system", label: "System", icon: "monitor" },
  ];

  return (
    <>
      {options.map((opt) => (
        <DropdownMenuItem key={opt.value} onClick={() => setTheme(opt.value)} className="gap-2">
          <Icon name={opt.icon} className="text-muted-foreground size-4" />
          <span className="flex-1">{opt.label}</span>
          {theme === opt.value && <Icon name="check" className="size-4" />}
        </DropdownMenuItem>
      ))}
    </>
  );
}

/**
 * The app's account cluster — Saldo chip plus the avatar dropdown that
 * carries every asset destination (Wiki, Wallet, Top Up, Code, Skills,
 * Memory, Databases), the theme switcher, and sign-out. Rendered into the
 * Workbench's top bars; selecting an asset swaps the center pane via
 * App-owned `assetView` state (Esc/onBack returns).
 */
export function ProfileControls({
  assetView,
  userId,
  walletAvailable = true,
  codegraphAvailable = false,
  onSelectAsset,
  onLogout,
}: {
  assetView: AssetViewId | null;
  userId: string | null;
  /** Backend has Monad compiled in (opt-in `monad` feature) — hide the wallet entry when off. */
  walletAvailable?: boolean;
  /** Backend has CodeGraph compiled in (opt-in `codegraph` feature) — hide the code entry when off. */
  codegraphAvailable?: boolean;
  onSelectAsset: (id: AssetViewId) => void;
  onLogout: () => void;
}) {
  const assets = ASSET_NAV.filter(
    (asset) => (asset.id !== "code" || codegraphAvailable) && (asset.id !== "wallet" || walletAvailable),
  );

  return (
    <div className="flex shrink-0 items-center gap-1">
      <TokenBalanceChip onSelectAsset={onSelectAsset} />
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            aria-label="Assets and account"
            className="ml-0.5 shrink-0 gap-1.5"
            size="icon"
            title={`Signed in as ${userId ?? "demo"}`}
            variant="ghost"
          >
            <span className="bg-primary text-primary-foreground relative flex size-7 items-center justify-center rounded-full text-xs font-semibold">
              {(userId ?? "d").charAt(0).toUpperCase()}
              {assetView != null && (
                <span className="bg-primary -top-0.5 -right-0.5 absolute size-2 rounded-full ring-2 ring-background" />
              )}
            </span>
            <span className="hidden lg:inline-flex items-center font-mono text-xs tracking-wider uppercase text-muted-foreground">
              Assets
            </span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60">
          <DropdownMenuLabel className="font-mono text-xs break-all">{userId ?? "demo"}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="font-mono text-xs tracking-wider uppercase text-muted-foreground">
            Assets
          </DropdownMenuLabel>
          {assets.map((asset) => (
            <DropdownMenuItem
              key={asset.id}
              className="gap-2"
              onClick={() => onSelectAsset(asset.id)}
              title={`${asset.label} · ${asset.subtitle}`}
            >
              <Icon name={asset.icon} className="text-muted-foreground size-4" />
              <span className="flex flex-1 flex-col leading-tight">
                <span className="text-sm font-medium">{asset.label}</span>
                <span className="text-muted-foreground text-xs">{asset.subtitle}</span>
              </span>
              {assetView === asset.id && <Icon name="check" className="size-4" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <ThemeItems />
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-2" onClick={onLogout}>
            <Icon name="log-out" className="text-muted-foreground size-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
