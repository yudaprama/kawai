import { useCallback, useEffect, useMemo, useState } from "react";
import type { ContextOnboarding } from "@/features/agents/registry";
import { contextTabsFor } from "@/features/agents/registry";
import { call, type AgentInfo, type KnowledgeFileInfo } from "@/lib/api";
import { isTabularExt } from "@/lib/extensions";

/**
 * Empty-data onboarding policy for agents whose pane has a sources tab
 * (today: analytics). Shows the "No data connected yet" card only while the
 * user sits on an empty session with no tabular files AND no SQL profiles.
 * Owns the profile polling + the imperative tab-focus counter; App only
 * supplies shell capabilities (open canvas/drawer) and chat state.
 */
export function useContextOnboarding(args: {
  agent: Pick<AgentInfo, "id" | "tools"> | null;
  inSession: boolean;
  knowledgeLoaded: boolean;
  files: KnowledgeFileInfo[];
  /** Shell signals that re-run the probe — opening the canvas or the mobile
   *  drawer must pick up a just-connected database. */
  canvasOpen: boolean;
  mobileDrawer: string | null;
  /** Opens the context pane (desktop canvas + mobile drawer fallback). */
  openContextPane: () => void;
  /** File-import action offered by the card. */
  importFiles: () => void;
}): { onboarding: ContextOnboarding | null; sourcesFocus: number } {
  const { agent, inSession, knowledgeLoaded, files, canvasOpen, mobileDrawer, openContextPane, importFiles } = args;

  const relevant = useMemo(() => contextTabsFor(agent).some((t) => t.id === "sources"), [agent]);

  const [profileCount, setProfileCount] = useState<number | null>(null);
  const [sourcesFocus, setSourcesFocus] = useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: canvasOpen/mobileDrawer are deliberate refresh triggers (pick up a just-connected database)
  useEffect(() => {
    if (!relevant || inSession) return;
    let disposed = false;
    call<{ name: string }[]>("sql_profile_list")
      .then((list) => {
        if (!disposed) setProfileCount(list.length);
      })
      .catch(() => {
        if (!disposed) setProfileCount(null);
      });
    return () => {
      disposed = true;
    };
  }, [relevant, inSession, canvasOpen, mobileDrawer]);

  const onImport = useCallback(() => importFiles(), [importFiles]);
  const onConnect = useCallback(() => {
    openContextPane();
    setSourcesFocus((n) => n + 1);
  }, [openContextPane]);

  const hasTabular = useMemo(() => files.some((f) => isTabularExt(f.ext)), [files]);

  const onboarding =
    relevant && !inSession && knowledgeLoaded && profileCount === 0 && !hasTabular ? { onImport, onConnect } : null;

  return { onboarding, sourcesFocus };
}
