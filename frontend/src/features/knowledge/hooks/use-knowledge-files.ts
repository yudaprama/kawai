import { useCallback, useEffect, useRef, useState } from "react";
import type { KnowledgeFileInfo } from "@/lib/api";
import { useOp } from "@/hooks/use-op";

/**
 * The knowledge panel list: every stored document with its RAG index state
 * and whether the ACTIVE session can search it — one `knowledge_list` call.
 * Re-fetched when the session changes and after any mutation (import / add /
 * remove / delete); mutations also patch state optimistically so index runs
 * feel immediate. When the backend runs without the `office` feature the call
 * rejects and we settle on an empty list.
 */
export function useKnowledgeFiles(enabled: boolean) {
  const op = useOp<KnowledgeFileInfo[]>("knowledge_list", undefined, { enabled });
  const files = op.data ?? [];
  const unavailable = op.unavailable;

  // `loaded` = first fetch completed (success or error). useOp starts
  // with `loading=false` then immediately sets it to `true` via auto-execute,
  // so we track the first transition back to `false`.
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (!op.loading && !loaded) setLoaded(true);
  }, [op.loading, loaded]);

  const sessionIdRef = useRef<number | null>(null);

  /** Track the active session (drives `inSession` + a re-fetch). */
  const setSessionId = useCallback(
    (sessionId: number | null) => {
      if (sessionId === sessionIdRef.current) return;
      sessionIdRef.current = sessionId;
      void op.execute(sessionId != null ? { sessionId } : undefined);
    },
    [op.execute],
  );

  /** Optimistically mark files as being (re)indexed (import / add / retry). */
  const markIndexing = useCallback(
    (fileIds: string[]) => {
      op.setData((prev) =>
        (prev ?? []).map((f) => (fileIds.includes(f.id) ? { ...f, status: "indexing", error: null } : f)),
      );
    },
    [op.setData],
  );

  /** Optimistically flip session association before the backend confirms. */
  const markInSession = useCallback(
    (fileIds: string[], inSession: boolean) => {
      op.setData((prev) => (prev ?? []).map((f) => (fileIds.includes(f.id) ? { ...f, inSession } : f)));
    },
    [op.setData],
  );

  /** Optimistically drop files (delete). */
  const remove = useCallback(
    (fileIds: string[]) => {
      op.setData((prev) => (prev ?? []).filter((f) => !fileIds.includes(f.id)));
    },
    [op.setData],
  );

  return {
    files,
    loaded,
    unavailable,
    refresh: op.execute,
    setSessionId,
    markIndexing,
    markInSession,
    remove,
  };
}
