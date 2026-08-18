import { useCallback, useEffect, useState } from "react";
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

  useEffect(() => {
    if (enabled && !loaded) void refresh();
  }, [enabled, loaded, refresh]);

  return { files, loaded, unavailable, refresh };
}
