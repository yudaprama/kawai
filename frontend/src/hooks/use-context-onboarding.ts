import { useCallback, useEffect, useMemo, useState } from "react";
import type { ContextOnboarding } from "@/features/agents/registry";
import { call, type AgentInfo, type KnowledgeFileInfo } from "@/lib/api";
import { isTabularExt } from "@/lib/extensions";

/**
 * Empty-data onboarding policy for the analytics agent. Shows the "No data
 * connected yet" card only while the user sits on an empty session with no
 * tabular files AND no SQL profiles. Owns the profile polling; App supplies
 * the shell actions (file import, open the Databases asset page).
 */
export function useContextOnboarding(args: {
  agent: Pick<AgentInfo, "id" | "tools"> | null;
  inSession: boolean;
  knowledgeLoaded: boolean;
  files: KnowledgeFileInfo[];
  /** File-import action offered by the card. */
  importFiles: () => void;
  /** "Connect database" CTA — opens the Databases asset page. */
  openSources: () => void;
}): { onboarding: ContextOnboarding | null } {
  const { agent, inSession, knowledgeLoaded, files, importFiles, openSources } = args;

  const relevant = useMemo(
    () => Boolean(agent?.tools) && agent?.id === "builtin.analytics",
    [agent],
  );

  const [profileCount, setProfileCount] = useState<number | null>(null);

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
  }, [relevant, inSession]);

  const onImport = useCallback(() => importFiles(), [importFiles]);
  const onConnect = useCallback(() => openSources(), [openSources]);

  const hasTabular = useMemo(() => files.some((f) => isTabularExt(f.ext)), [files]);

  const onboarding =
    relevant && !inSession && knowledgeLoaded && profileCount === 0 && !hasTabular ? { onImport, onConnect } : null;

  return { onboarding };
}
