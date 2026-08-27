import { useCallback, useEffect, useState } from "react";
import { type MemoryItem, call, errText } from "@/lib/api";
import { logError } from "@/lib/logger";
import { showErrorToast } from "@/lib/utils";

/**
 * The Memory page's L1 state: the global memory list plus CRUD and the
 * cloud-tier extraction (`memory_extract` — errors with guidance when no
 * vault provider is configured).
 */
export function useMemories(enabled: boolean) {
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [extracting, setExtracting] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setMemories(await call<MemoryItem[]>("memory_list"));
    } catch (err) {
      logError("memory_list", err);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (enabled && !loaded) void refresh();
  }, [enabled, loaded, refresh]);

  const create = useCallback(
    async (kind: MemoryItem["kind"], title: string, content: string): Promise<MemoryItem | null> => {
      try {
        const item = await call<MemoryItem>("memory_create", { kind, title, content });
        setMemories((prev) => [item, ...prev]);
        return item;
      } catch (err) {
        showErrorToast(`Couldn't create the memory — ${errText(err)}`);
        return null;
      }
    },
    [],
  );

  const update = useCallback(
    async (
      memoryId: string,
      patch: { kind?: MemoryItem["kind"]; title?: string; content?: string },
    ): Promise<MemoryItem | null> => {
      try {
        const item = await call<MemoryItem | null>("memory_update", { memoryId, ...patch });
        if (item) setMemories((prev) => prev.map((m) => (m.id === memoryId ? item : m)));
        return item;
      } catch (err) {
        showErrorToast(`Couldn't update the memory — ${errText(err)}`);
        return null;
      }
    },
    [],
  );

  const remove = useCallback(async (memoryId: string): Promise<boolean> => {
    try {
      const removed = await call<boolean>("memory_delete", { memoryId });
      if (removed) setMemories((prev) => prev.filter((m) => m.id !== memoryId));
      return removed;
    } catch (err) {
      showErrorToast(`Couldn't delete the memory — ${errText(err)}`);
      return false;
    }
  }, []);

  /** Extract memories from a session transcript via the cloud tier. */
  const extract = useCallback(async (sessionId: number): Promise<MemoryItem[]> => {
    setExtracting(true);
    try {
      const stored = await call<MemoryItem[]>("memory_extract", { sessionId });
      if (stored.length) setMemories((prev) => [...stored, ...prev]);
      return stored;
    } catch (err) {
      showErrorToast(`Extraction failed — ${errText(err)}`);
      return [];
    } finally {
      setExtracting(false);
    }
  }, []);

  return { memories, loaded, extracting, refresh, create, update, remove, extract };
}
