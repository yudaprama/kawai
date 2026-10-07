import { createContext } from "react";
import type { AssetViewId } from "./asset-nav";

/** Asset-switcher inputs for the asset workspace — App owns this state
 *  (center-pane swap, feature availability) and provides it once around the
 *  workspace; AssetShell's header consumes it so every asset page carries the
 *  same rail. The account cluster (Saldo chip + avatar dropdown) is NOT here:
 *  it lives in the global mode bar, one row above every surface, so it cannot
 *  drift between the Workbench and an asset page. Null = standalone shell. */
export interface AssetChrome {
  assetView: AssetViewId | null;
  walletAvailable: boolean;
  codegraphAvailable: boolean;
  onSelectAsset: (id: AssetViewId) => void;
}

export const AssetChromeContext = createContext<AssetChrome | null>(null);
