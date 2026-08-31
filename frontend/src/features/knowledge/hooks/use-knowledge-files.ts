import { useCallback, useEffect, useRef, useState } from "react";
import { call, type KnowledgeFileInfo } from "@/lib/api";
import { logWarn } from "@/lib/logger";

/**
 * The knowledge panel list: every stored document with its RAG index state
 * and whether the ACTIVE session can search it — one `knowledge_list` call.
 * Re-fetched when the session changes and after any mutation (import / add /
 * remove / delete); mutations also patch state optimistically so index runs
 * feel immediate. When the backend runs without the `office` feature the call
 * rejects and we settle on an empty list.
 */
export function useKnowledgeFiles(enabled: boolean) {
  const [files, setFiles] = useState<KnowledgeFileInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const sessionIdRef = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    try {
      const rows = await call<KnowledgeFileInfo[]>("knowledge_list", sessionId != null ? { sessionId } : undefined);
      setFiles(rows);
      setUnavailable(false);
    } catch (err) {
      // Feature-gated command missing (no `office` build) or not authed yet.
      logWarn("knowledge_list", err);
      setUnavailable(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  /** Track the active session (drives `inSession` + a re-fetch). */
  const setSessionId = useCallback(
    (sessionId: number | null) => {
      if (sessionId === sessionIdRef.current) return;
      sessionIdRef.current = sessionId;
      void refresh();
    },
    [refresh],
  );

  /** Optimistically mark files as being (re)indexed (import / add / retry). */
  const markIndexing = useCallback((fileIds: string[]) => {
    setFiles((prev) => prev.map((f) => (fileIds.includes(f.id) ? { ...f, status: "indexing", error: null } : f)));
  }, []);

  /** Optimistically flip session association before the backend confirms. */
  const markInSession = useCallback((fileIds: string[], inSession: boolean) => {
    setFiles((prev) => prev.map((f) => (fileIds.includes(f.id) ? { ...f, inSession } : f)));
  }, []);

  /** Optimistically drop files (delete). */
  const remove = useCallback((fileIds: string[]) => {
    setFiles((prev) => prev.filter((f) => !fileIds.includes(f.id)));
  }, []);

  useEffect(() => {
    if (enabled && !loaded) void refresh();
  }, [enabled, loaded, refresh]);

  return {
    files,
    loaded,
    unavailable,
    refresh,
    setSessionId,
    markIndexing,
    markInSession,
    remove,
  };
}
