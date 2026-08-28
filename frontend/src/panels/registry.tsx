import type { AgentInfo } from "@/lib/api";

/**
 * Per-agent composition of the right context pane — the UI counterpart of
 * `AGENT_META` in agents-rail.tsx. The backend catalog (`list_agents`) stays
 * the single source of truth for agent identity; this map only decides which
 * tabs the pane shows for a given id. Agents absent from the map (or with
 * `tools: false`) get no context pane at all.
 */

/** Ids of the tab contents rendered by ContextPanel (context-panel.tsx). */
export type ContextTabId = "session" | "library" | "sources";

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
  // Analytics adds the SQL data sources its tools are built on. The file
  // lists themselves stay shared with office — one store backs both.
  "builtin.analytics": [
    { id: "session", label: "In this session" },
    { id: "library", label: "Library" },
    { id: "sources", label: "Databases" },
  ],
};

/** Ordered tab specs for an agent; empty → the agent has no context pane. */
export function contextTabsFor(agent: Pick<AgentInfo, "id" | "tools"> | null): ContextTabSpec[] {
  if (!agent?.tools) return [];
  return CONTEXT_TABS[agent.id] ?? [];
}

/** Empty-state onboarding card for agents whose data lives in files/SQL
 *  sources (shown by ConversationPanel instead of the suggested prompts). */
export interface ContextOnboarding {
  onImport: () => void;
  onConnect: () => void;
}
