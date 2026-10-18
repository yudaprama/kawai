import type { AgentInfo } from "@/lib/api";

/**
 * Per-agent composition of the right context pane. The backend catalog
 * (`list_agents`) stays the single source of truth for agent identity; this
 * map only decides which tabs the pane shows for a given id. Agents absent
 * from the map (or with `tools: false`) get no context pane at all.
 */

/** Ids of the tab contents rendered by ContextPanel (context-panel.tsx). */
export type ContextTabId = "session" | "library";

export interface ContextTabSpec {
  id: ContextTabId;
  label: string;
}

const CONTEXT_TABS: Record<string, ContextTabSpec[]> = {
  "builtin.office": [
    { id: "session", label: "In this session" },
    { id: "library", label: "Library" },
  ],
  "builtin.presentation": [
    { id: "session", label: "In this session" },
    { id: "library", label: "Library" },
  ],
  // Analytics shares office's file lists — one store backs both. Its SQL
  // data sources (sql_profiles) are managed on the Credentials asset page.
  "builtin.analytics": [
    { id: "session", label: "In this session" },
    { id: "library", label: "Library" },
  ],
  // Accounting's ledger lives in its own SQLite tables, but the Library tab
  // is still its intake surface: uploaded bank/gateway statement CSVs are
  // what reconcile_csv reads.
  "builtin.accounting": [
    { id: "session", label: "In this session" },
    { id: "library", label: "Library" },
  ],
};

/** Ordered tab specs for an agent; empty → the agent has no context pane. */
export function contextTabsFor(agent: Pick<AgentInfo, "id" | "tools"> | null): ContextTabSpec[] {
  if (!agent?.tools) return [];
  return CONTEXT_TABS[agent.id] ?? [];
}

/** Empty-state onboarding card for agents whose data lives in files/SQL
 *  sources (surfaced in the Workbench composer instead of suggested prompts). */
export interface ContextOnboarding {
  onImport: () => void;
  onConnect: () => void;
}
