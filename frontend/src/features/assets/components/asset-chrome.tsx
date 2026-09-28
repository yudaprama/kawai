import { createContext } from "react";
import type { AssetViewId } from "./asset-nav";

/** Account-cluster inputs for the asset workspace — App owns this state
 *  (center-pane swap, feature availability, sign-out) and provides it once
 *  around the workspace; AssetShell's header consumes it so every asset page
 *  carries the same controls as the Workbench top bar (asset switcher,
 *  balance chip, theme, sign-out). Null = no chrome available (standalone
 *  shell). */
export interface AssetChrome {
  assetView: AssetViewId | null;
  userId: string | null;
  walletAvailable: boolean;
  codegraphAvailable: boolean;
  onSelectAsset: (id: AssetViewId) => void;
  onLogout: () => void;
}

export const AssetChromeContext = createContext<AssetChrome | null>(null);
