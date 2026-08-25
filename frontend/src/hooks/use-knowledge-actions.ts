import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useKnowledgeFiles } from "@/hooks/use-knowledge-files";
import { useRetryableToast } from "@/hooks/use-retryable-toast";
import { call, errText, type KnowledgeFileInfo, type OfficeFileInfo } from "@/lib/api";
import { dataUrlToFile, fileToBase64 } from "@/lib/base64";
import { ADD_FILE_ACCEPT } from "@/lib/extensions";
import type { KnowledgeSource } from "@/lib/knowledge";
import { classifySource, isYouTubeUrl } from "@/lib/knowledge";
import { logWarn } from "@/lib/logger";
import { showErrorToast } from "@/lib/utils";
import { platform, runningInTauri } from "@/platform";

export function useKnowledgeActions(chat: {
  sessionId: number | null;
  ensureSessionId: (hint?: string) => Promise<number | null>;
}) {
  const knowledge = useKnowledgeFiles(true);
  const sessionFiles = chat.sessionId != null ? knowledge.files.filter((f) => f.inSession) : [];

  const [importing, setImporting] = useState(false);
  const [linking, setLinking] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [previewFile, setPreviewFile] = useState<KnowledgeFileInfo | null>(null);
  const [linkPromptOpen, setLinkPromptOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const runWithRetry = useRetryableToast();

  useEffect(() => {
    knowledge.setSessionId(chat.sessionId);
  }, [chat.sessionId, knowledge]);

  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3000);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  const importKnowledgeFiles = useCallback(
    async (
      items: { sourcePath?: string; file?: File; name: string }[],
      opts?: { sessionId?: number | null },
    ): Promise<{ importedIds: string[]; failed: { name: string; error: string }[] }> => {
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
      const importedIds: string[] = [];
      const failed: { name: string; error: string }[] = [];
      for (const [i, res] of settled.entries()) {
        if (res.status === "fulfilled" && res.value?.id) {
          importedIds.push(res.value.id);
        } else {
          const reason = res.status === "rejected" ? res.reason : new Error("import returned no id");
          logWarn("office_import_file", reason);
          failed.push({ name: items[i]?.name ?? "?", error: errText(reason) });
        }
      }
      if (importedIds.length) {
        const runs = importedIds.map((fileId) =>
          call<number>("office_index_file", { sessionId, fileId })
            .catch((e) => logWarn("office_index_file", e))
            .finally(() => void knowledge.refresh()),
        );
        await knowledge.refresh();
        knowledge.markIndexing(importedIds);
        void Promise.allSettled(runs);
      }
      return { importedIds, failed };
    },
    [chat.sessionId, knowledge],
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
      const { importedIds, failed } = await importKnowledgeFiles(toImport);
      if (importedIds.length) {
        toast.success(`Imported ${importedIds.length} file${importedIds.length > 1 ? "s" : ""}`, {
          description: "Indexing runs in the background.",
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
        knowledge.setSessionId(sid);
      }
      knowledge.markInSession([file.id], true);
      if (file.chunks === 0 || file.status === "failed") knowledge.markIndexing([file.id]);
      try {
        await call<number>("knowledge_add_to_session", {
          sessionId: sid,
          fileIds: [file.id],
        });
      } catch (err) {
        showErrorToast(err);
      } finally {
        await knowledge.refresh();
      }
    },
    [chat.sessionId, chat.ensureSessionId, knowledge],
  );

  const removeFromSession = useCallback(
    async (file: KnowledgeFileInfo) => {
      if (chat.sessionId == null) return;
      knowledge.markInSession([file.id], false);
      try {
        await call<number>("knowledge_forget", {
          sessionId: chat.sessionId,
          fileIds: [file.id],
        });
      } catch (err) {
        showErrorToast(err);
      } finally {
        await knowledge.refresh();
      }
    },
    [chat.sessionId, knowledge],
  );

  const retryIndex = useCallback(
    async (file: KnowledgeFileInfo) => {
      knowledge.markIndexing([file.id]);
      try {
        await call<number>("office_index_file", {
          sessionId: chat.sessionId,
          fileId: file.id,
        });
      } catch (err) {
        logWarn("office_index_file", err);
      } finally {
        await knowledge.refresh();
      }
    },
    [chat.sessionId, knowledge],
  );

  const deleteFile = useCallback(
    async (file: KnowledgeFileInfo) => {
      if (confirmDeleteId !== file.id) {
        setConfirmDeleteId(file.id);
        return;
      }
      setConfirmDeleteId(null);
      knowledge.remove([file.id]);
      try {
        await call("office_delete_file", { fileId: file.id });
      } catch (err) {
        showErrorToast(err);
        await knowledge.refresh();
      }
    },
    [confirmDeleteId, knowledge],
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
      await knowledge.refresh();
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
  }, [chat.sessionId, knowledge, linkUrl, runWithRetry]);

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
