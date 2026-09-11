import { useCallback, useState } from "react";
import { type MemoryItem, call, errText } from "@/lib/api";
import { showErrorToast } from "@/lib/utils";
import { useOp } from "@/hooks/use-op";

/**
 * The Memory page's L1 state: the global memory list plus CRUD and the
 * cloud-tier extraction (`memory_extract` — errors with guidance when no
 * vault provider is configured).
 */
export function useMemories(enabled: boolean) {
  const listOp = useOp<MemoryItem[]>("memory_list", undefined, { enabled });
  const memories = listOp.data ?? [];
  const [extracting, setExtracting] = useState(false);
  const [consolidating, setConsolidating] = useState(false);

  const search = useCallback(async (query: string, limit?: number): Promise<MemoryItem[]> => {
    try {
      return await call<MemoryItem[]>("memory_search", { query, limit });
    } catch (err) {
      showErrorToast(`Search failed — ${errText(err)}`);
      return [];
    }
  }, []);

  /** Merge redundant memories (embedding clustering + cloud LLM merge). */
  const consolidate = useCallback(async (): Promise<number> => {
    setConsolidating(true);
    try {
      const report = await call<{ mergedGroups: number; removed: number }>("memory_consolidate", {});
      if (report.removed > 0) await listOp.execute();
      return report.removed;
    } catch (err) {
      showErrorToast(`Consolidation failed — ${errText(err)}`);
      return 0;
    } finally {
      setConsolidating(false);
    }
  }, [listOp.execute]);

  const create = useCallback(
    async (kind: MemoryItem["kind"], title: string, content: string): Promise<MemoryItem | null> => {
      try {
        const item = await call<MemoryItem>("memory_create", { kind, title, content });
        listOp.setData((prev) => [item, ...(prev ?? [])]);
        return item;
      } catch (err) {
        showErrorToast(`Couldn't create the memory — ${errText(err)}`);
        return null;
      }
    },
    [listOp.setData],
  );

  const update = useCallback(
    async (
      memoryId: string,
      patch: { kind?: MemoryItem["kind"]; title?: string; content?: string },
    ): Promise<MemoryItem | null> => {
      try {
        const item = await call<MemoryItem | null>("memory_update", { memoryId, ...patch });
        if (item) listOp.setData((prev) => (prev ?? []).map((m) => (m.id === memoryId ? item : m)));
        return item;
      } catch (err) {
        showErrorToast(`Couldn't update the memory — ${errText(err)}`);
        return null;
      }
    },
    [listOp.setData],
  );

  const remove = useCallback(
    async (memoryId: string): Promise<boolean> => {
      try {
        const removed = await call<boolean>("memory_delete", { memoryId });
        if (removed) listOp.setData((prev) => (prev ?? []).filter((m) => m.id !== memoryId));
        return removed;
      } catch (err) {
        showErrorToast(`Couldn't delete the memory — ${errText(err)}`);
        return false;
      }
    },
    [listOp.setData],
  );

  /** Extract memories from a session transcript via the cloud tier. */
  const extract = useCallback(
    async (sessionId: number): Promise<MemoryItem[]> => {
      setExtracting(true);
      try {
        const stored = await call<MemoryItem[]>("memory_extract", { sessionId });
        if (stored.length) listOp.setData((prev) => [...stored, ...(prev ?? [])]);
        return stored;
      } catch (err) {
        showErrorToast(`Extraction failed — ${errText(err)}`);
        return [];
      } finally {
        setExtracting(false);
      }
    },
    [listOp.setData],
  );

  return {
    memories,
    loaded: !listOp.loading || memories.length > 0,
    extracting,
    consolidating,
    refresh: listOp.execute,
    create,
    update,
    remove,
    extract,
    search,
    consolidate,
  };
}
