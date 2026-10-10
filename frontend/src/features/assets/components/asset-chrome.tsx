import { createContext } from "react";
import type { AssetViewId } from "./asset-nav";

/** Asset-switcher inputs for the asset workspace — App owns this state
 *  (center-pane swap, feature availability) and provides it once around the
 *  workspace, so the mobile nav drawer and the in-workspace connections
 *  composer can read the same values. The account cluster (Saldo chip + avatar
 *  dropdown) is NOT here: it lives in the global mode bar, one row above every
 *  surface, so it cannot drift between the Workbench and an asset page. Null =
 *  standalone shell. */
export interface AssetChrome {
  assetView: AssetViewId | null;
  walletAvailable: boolean;
  codegraphAvailable: boolean;
  onSelectAsset: (id: AssetViewId) => void;
}

export const AssetChromeContext = createContext<AssetChrome | null>(null);
