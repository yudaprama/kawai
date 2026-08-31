import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useKnowledgeFiles } from "@/features/knowledge/hooks/use-knowledge-files";
import { useRetryableToast } from "@/hooks/use-retryable-toast";
import { call, errText, type KnowledgeFileInfo, type OfficeFileInfo } from "@/lib/api";
import { dataUrlToFile, fileToBase64 } from "@/lib/base64";
import { ADD_FILE_ACCEPT } from "@/lib/extensions";
import type { KnowledgeSource } from "@/features/knowledge/lib/knowledge";
import { classifySource, isYouTubeUrl } from "@/features/knowledge/lib/knowledge";
import { isTabularExt } from "@/lib/extensions";
import { logWarn } from "@/lib/logger";
import { showErrorToast } from "@/lib/utils";
import { platform, runningInTauri } from "@/platform";

export function useKnowledgeActions(chat: {
  sessionId: number | null;
  ensureSessionId: (hint?: string) => Promise<number | null>;
}) {
  // Destructure the stable callbacks — `knowledge` itself is a fresh object
  // literal every render, so depending on it would rebuild every callback
  // below on each render and defeat memoization.
  const knowledge = useKnowledgeFiles(true);
  const {
    files: knowledgeFiles,
    refresh: refreshKnowledge,
    setSessionId: setKnowledgeSessionId,
    markIndexing,
    markInSession,
    remove: removeKnowledgeRows,
  } = knowledge;
  const sessionFiles = chat.sessionId != null ? knowledgeFiles.filter((f) => f.inSession) : [];

  const [importing, setImporting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<KnowledgeFileInfo | null>(null);
  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const runWithRetry = useRetryableToast();

  useEffect(() => {
    setKnowledgeSessionId(chat.sessionId);
  }, [chat.sessionId, setKnowledgeSessionId]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  const importKnowledgeFiles = useCallback(
    async (
      items: { sourcePath?: string; file?: File; name: string }[],
      opts?: { sessionId?: number | null },
    ): Promise<{ importedIds: string[]; failed: { name: string; error: string }[]; indexing: number }> => {
      const sessionId = opts && "sessionId" in opts ? opts.sessionId : chat.sessionId;
      // All imports run in parallel and independently — one bad file must
      // not abort the rest of the batch.
      const settled = await Promise.allSettled(
        items.map(async (item) => {
          if (item.sourcePath) {
            return call<OfficeFileInfo>("office_import_file", {
              sourcePath: item.sourcePath,
            });
          }
          if (item.file) {
            const dataBase64 = await fileToBase64(item.file);
            return call<OfficeFileInfo>("office_import_file", {
              dataBase64,
              name: item.name,
            });
          }
          throw new Error("nothing to import");
        }),
      );
      const imported: OfficeFileInfo[] = [];
      const failed: { name: string; error: string }[] = [];
      for (const [i, res] of settled.entries()) {
        if (res.status === "fulfilled" && res.value?.id) {
          imported.push(res.value);
        } else {
          const reason = res.status === "rejected" ? res.reason : new Error("import returned no id");
          logWarn("office_import_file", reason);
          failed.push({ name: items[i]?.name ?? "?", error: errText(reason) });
        }
      }
      const importedIds = imported.map((f) => f.id);
      const indexableIds = imported.filter((f) => !isTabularExt(f.ext)).map((f) => f.id);
      const tabularIds = imported.filter((f) => isTabularExt(f.ext)).map((f) => f.id);
      if (importedIds.length) {
        // Tabular files (csv/tsv/parquet/xlsx) are queried structurally by
        // the analytics agent — no RAG indexing. They only need the session
        // association, which office_index_file skips for them.
        const runs: Promise<unknown>[] = [];
        if (tabularIds.length && sessionId != null) {
          runs.push(
            call<number>("knowledge_add_to_session", {
              sessionId,
              fileIds: tabularIds,
            })
              .catch((e) => logWarn("knowledge_add_to_session", e))
              .finally(() => void refreshKnowledge()),
          );
        }
        if (indexableIds.length) {
          runs.push(
            ...indexableIds.map((fileId) =>
              call<number>("office_index_file", { sessionId, fileId })
                .catch((e) => logWarn("office_index_file", e))
                .finally(() => void refreshKnowledge()),
            ),
          );
        }
        await refreshKnowledge();
        markIndexing(indexableIds);
        void Promise.allSettled(runs);
      }
      return { importedIds, failed, indexing: indexableIds.length };
    },
    [chat.sessionId, refreshKnowledge, markIndexing],
  );

  const addKnowledgeFiles = useCallback(async () => {
    setImporting(true);
    const toImport: { sourcePath?: string; file?: File; name: string }[] = [];
    let picked: KnowledgeSource[];
    try {
      if (runningInTauri) {
        const paths = await platform.pickFilePaths({
          accept: ADD_FILE_ACCEPT,
          multiple: true,
        });
        if (!paths?.length) return;
        picked = paths.map((p) => classifySource(p.split(/[\\/]/).pop() ?? p, { path: p }));
      } else {
        const pickedFiles = await platform.pickFiles({
          accept: ADD_FILE_ACCEPT,
          multiple: true,
        });
        if (!pickedFiles?.length) return;
        picked = pickedFiles.map((f) => classifySource(f.name, { file: f }));
      }
      for (const item of picked) {
        if (item.kind === "file") {
          toImport.push({
            name: item.name,
            sourcePath: item.sourcePath,
            file: item.file,
          });
        } else {
          showErrorToast(`Unsupported file type: ${item.name}`);
        }
      }
      const { importedIds, failed, indexing } = await importKnowledgeFiles(toImport);
      if (importedIds.length) {
        toast.success(`Imported ${importedIds.length} file${importedIds.length > 1 ? "s" : ""}`, {
          description: indexing > 0 ? "Indexing runs in the background." : "Ready — the Analytics agent can query it.",
        });
      }
      if (failed.length) {
        showErrorToast(
          `Couldn't import ${failed.length} file${failed.length > 1 ? "s" : ""}: ${failed.map((f) => f.name).join(", ")}`,
        );
      }
    } catch (err) {
      logWarn("office_import_file", err);
      showErrorToast(err);
    } finally {
      setImporting(false);
    }
  }, [importKnowledgeFiles]);

  const imageToKnowledge = useCallback(
    async (dataUrl: string, name: string): Promise<string[]> => {
      let sid = chat.sessionId;
      if (sid == null) {
        sid = await chat.ensureSessionId(name);
      }
      const mime = dataUrl.slice(5, dataUrl.indexOf(";"));
      const ext = mime.split("/")[1] ?? "png";
      try {
        const { importedIds, failed } = await importKnowledgeFiles(
          [
            {
              name: `${name}.${ext}`,
              file: dataUrlToFile(dataUrl, `${name}.${ext}`),
            },
          ],
          { sessionId: sid },
        );
        if (failed.length || importedIds.length === 0) {
          showErrorToast(failed[0]?.error ?? "Couldn't save the image");
          return [];
        }
        toast.success("Image saved to knowledge", {
          description: "Indexing runs in the background.",
        });
        return importedIds;
      } catch (err) {
        showErrorToast(err);
        return [];
      }
    },
    [chat.sessionId, chat.ensureSessionId, importKnowledgeFiles],
  );

  const addToSession = useCallback(
    async (file: KnowledgeFileInfo) => {
      let sid = chat.sessionId;
      if (sid == null) {
        sid = await chat.ensureSessionId(file.originalName);
        if (sid == null) return;
        setKnowledgeSessionId(sid);
      }
      markInSession([file.id], true);
      // Tabular files are never prose-indexed — no "Indexing…" state to show.
      if (!isTabularExt(file.ext) && (file.chunks === 0 || file.status === "failed")) {
        markIndexing([file.id]);
      }
      try {
        await call<number>("knowledge_add_to_session", {
          sessionId: sid,
          fileIds: [file.id],
        });
      } catch (err) {
        showErrorToast(err);
      } finally {
        await refreshKnowledge();
      }
    },
    [chat.sessionId, chat.ensureSessionId, setKnowledgeSessionId, markInSession, markIndexing, refreshKnowledge],
  );

  const removeFromSession = useCallback(
    async (file: KnowledgeFileInfo) => {
      if (chat.sessionId == null) return;
      markInSession([file.id], false);
      try {
        await call<number>("knowledge_forget", {
          sessionId: chat.sessionId,
          fileIds: [file.id],
        });
      } catch (err) {
        showErrorToast(err);
      } finally {
        await refreshKnowledge();
      }
    },
    [chat.sessionId, markInSession, refreshKnowledge],
  );

  const retryIndex = useCallback(
    async (file: KnowledgeFileInfo) => {
      markIndexing([file.id]);
      try {
        await call<number>("office_index_file", {
          sessionId: chat.sessionId,
          fileId: file.id,
        });
      } catch (err) {
        logWarn("office_index_file", err);
      } finally {
        await refreshKnowledge();
      }
    },
    [chat.sessionId, markIndexing, refreshKnowledge],
  );

  const deleteFile = useCallback(
    async (file: KnowledgeFileInfo) => {
      if (confirmDeleteId !== file.id) {
        setConfirmDeleteId(file.id);
        return;
      }
      setConfirmDeleteId(null);
      removeKnowledgeRows([file.id]);
      try {
        await call("office_delete_file", { fileId: file.id });
      } catch (err) {
        showErrorToast(err);
        await refreshKnowledge();
      }
    },
    [confirmDeleteId, removeKnowledgeRows, refreshKnowledge],
  );

  const openPreview = useCallback((file: KnowledgeFileInfo) => setPreviewFile(file), []);

  const addKnowledgeLink = useCallback(() => {
    setLinkUrl("");
    setLinkPromptOpen(true);
  }, []);

  const submitKnowledgeLink = useCallback(async () => {
    const url = linkUrl.trim();
    if (!url) return;
    if (!isYouTubeUrl(url)) {
      showErrorToast("Only YouTube URLs are supported for now");
      setLinkPromptOpen(false);
      return;
    }
    setLinkPromptOpen(false);
    setLinking(true);
    const importVideo = async () => {
      const info = await call<OfficeFileInfo>("knowledge_import_youtube", {
        url,
        sessionId: chat.sessionId,
      });
      await refreshKnowledge();
      return info;
    };
    try {
      const info = await importVideo();
      toast.success(`Imported ${info.originalName}`, {
        description: "Indexing runs in the background.",
      });
    } catch (err) {
      logWarn("knowledge_import_youtube", err);
      runWithRetry(`Couldn't import the YouTube video — ${errText(err)}`, importVideo);
    } finally {
      setLinking(false);
    }
  }, [chat.sessionId, refreshKnowledge, linkUrl, runWithRetry]);

  return {
    knowledge,
    sessionFiles,
    importing,
    linking,
    confirmDeleteId,
    previewFile,
    setPreviewFile,
    linkPromptOpen,
    setLinkPromptOpen,
    linkUrl,
    setLinkUrl,
    addKnowledgeFiles,
    imageToKnowledge,
    addToSession,
    removeFromSession,
    retryIndex,
    deleteFile,
    openPreview,
    addKnowledgeLink,
    submitKnowledgeLink,
  };
}
