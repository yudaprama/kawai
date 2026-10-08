import type { TranslationKey } from "@/lib/i18n";

/** Asset views openable from the account cluster (center-pane workspace
 *  pages). Media GENERATION is deliberately absent: those four lanes are
 *  modes in the global bar (`app/modes.ts`), reachable from every screen, so
 *  listing "Generator" here would give one destination a second, staler name
 *  ("civitai image gen") competing with the mode label beside it. */
export type AssetViewId =
  | "wiki"
  | "code"
  | "skills"
  | "memory"
  | "sources"
  | "wallet"
  | "topup"
  | "connections"
  | "binanceApi";

export interface AssetNavEntry {
  id: AssetViewId;
  labelKey: TranslationKey;
  subtitle: string;
  icon: string;
}

/** The app's asset nav — presentation only, owned by the frontend. All
 *  entries open from the avatar dropdown in the header; the mobile nav
 *  drawer lists them vertically. */
export const ASSET_NAV: AssetNavEntry[] = [
  { id: "wiki", labelKey: "assetNav.wiki", subtitle: "knowledge base", icon: "book" },
  { id: "wallet", labelKey: "assetNav.wallet", subtitle: "Monad assets", icon: "wallet" },
  { id: "topup", labelKey: "assetNav.topUp", subtitle: "app tokens", icon: "qr-code" },
  { id: "code", labelKey: "assetNav.code", subtitle: "code graph", icon: "code-xml" },
  { id: "skills", labelKey: "assetNav.skills", subtitle: "agent skills", icon: "wrench" },
  { id: "memory", labelKey: "assetNav.memory", subtitle: "chat memory", icon: "brain" },
  { id: "sources", labelKey: "assetNav.databases", subtitle: "SQL sources", icon: "database" },
  { id: "connections", labelKey: "assetNav.connections", subtitle: "app connections", icon: "plug-zap" },
  { id: "binanceApi", labelKey: "assetNav.binanceApi", subtitle: "Binance API", icon: "candlestick-chart" },
];
