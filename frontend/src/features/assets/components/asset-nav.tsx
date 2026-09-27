/** Asset views openable from the rail's Assets section (center-pane workspace pages). */
export type AssetViewId = "wiki" | "code" | "skills" | "memory" | "sources" | "wallet" | "topup";

export interface AssetNavEntry {
  id: AssetViewId;
  label: string;
  subtitle: string;
  icon: string;
}

/** The app's asset nav — presentation only, owned by the frontend. All
 *  entries open from the profile dropdown in the header; the mobile nav
 *  drawer lists them vertically. */
export const ASSET_NAV: AssetNavEntry[] = [
  { id: "wiki", label: "Wiki", subtitle: "knowledge base", icon: "book" },
  { id: "wallet", label: "KAWAI Wallet", subtitle: "Monad assets", icon: "wallet" },
  { id: "topup", label: "Top Up", subtitle: "app tokens", icon: "qr-code" },
  { id: "code", label: "Code", subtitle: "code graph", icon: "code-xml" },
  { id: "skills", label: "Skills", subtitle: "agent skills", icon: "wrench" },
  { id: "memory", label: "Memory", subtitle: "chat memory", icon: "brain" },
  { id: "sources", label: "Databases", subtitle: "SQL sources", icon: "database" },
];
