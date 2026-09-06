import { BookIcon, BrainIcon, CodeXmlIcon, DatabaseIcon, WalletIcon, WrenchIcon } from "lucide-react";

/** Asset views openable from the rail's Assets section (center-pane workspace pages). */
export type AssetViewId = "wiki" | "code" | "skills" | "memory" | "sources" | "wallet";

export interface AssetNavEntry {
  id: AssetViewId;
  label: string;
  subtitle: string;
  icon: typeof BookIcon;
}

/** The rail's Assets section — presentation only, owned by the frontend. */
export const ASSET_NAV: AssetNavEntry[] = [
  { id: "wiki", label: "Wiki", subtitle: "knowledge base", icon: BookIcon },
  { id: "wallet", label: "KAWAI Wallet", subtitle: "Monad assets", icon: WalletIcon },
  { id: "code", label: "Code", subtitle: "code graph", icon: CodeXmlIcon },
  { id: "skills", label: "Skills", subtitle: "agent skills", icon: WrenchIcon },
  { id: "memory", label: "Memory", subtitle: "chat memory", icon: BrainIcon },
  { id: "sources", label: "Databases", subtitle: "SQL sources", icon: DatabaseIcon },
];
