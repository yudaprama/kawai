import { useCallback, useEffect, useRef, useState } from "react";
import { call, errText, type OfficeFileInfo } from "@/lib/api";

/**
 * Lazy list of the user's stored knowledge documents (office store:
 * .docx/.xlsx/.pptx/.pdf imported via the office tools). Fetched on first
 * demand (composer focus / @ typed) and kept for the session — the store only
 * changes when the user imports files. When the backend runs without the
 * `office` feature the call rejects and we settle on an empty list (the
 * @-mention popup just shows "no documents").
 */
export function useKnowledgeFiles(enabled: boolean) {
  const [files, setFiles] = useState<OfficeFileInfo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<OfficeFileInfo[]>([]);
  const prevSessionId = useRef<number | null>(null);

  const refresh = useCallback(async () => {
    try {
      const rows = await call<OfficeFileInfo[]>("office_list_files");
      setFiles(rows);
      setUnavailable(false);
    } catch (err) {
      // Feature-gated command missing (no `office` build) or not authed yet.
      console.warn("[office_list_files]", errText(err));
      setUnavailable(true);
    } finally {
      setLoaded(true);
    }
  }, []);

  /** Load the files associated with the given session. */
  const loadSessionFiles = useCallback(async (sessionId: number) => {
    try {
      const rows = await call<OfficeFileInfo[]>("list_session_files", {
        sessionId,
      });
      setSessionFiles(rows);
    } catch (err) {
      console.warn("[list_session_files]", errText(err));
      setSessionFiles([]);
    }
  }, []);

  /** Reset session files when there's no active session. */
  const clearSessionFiles = useCallback(() => {
    setSessionFiles([]);
    prevSessionId.current = null;
  }, []);

  useEffect(() => {
    if (enabled && !loaded) void refresh();
  }, [enabled, loaded, refresh]);

  // Re-fetch session files when the session id changes (or becomes null).
  const setSessionId = useCallback(
    (sessionId: number | null) => {
      if (sessionId === prevSessionId.current) return;
      prevSessionId.current = sessionId;
      if (sessionId != null) {
        void loadSessionFiles(sessionId);
      } else {
        setSessionFiles([]);
      }
    },
    [loadSessionFiles],
  );

  return {
    files,
    loaded,
    unavailable,
    refresh,
    sessionFiles,
    setSessionId,
    clearSessionFiles,
    refreshSessionFiles: loadSessionFiles,
  };
}
