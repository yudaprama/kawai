import { useCallback, useEffect, useState } from "react";
import { call } from "@/lib/api";
import { logError } from "@/lib/logger";

/**
 * Load-once list state shared by the asset pages: one fetch when `enabled`
 * first turns true, `loaded` flag, exposed `refresh` for post-mutation
 * re-fetches. Failures are logged, never thrown — the page renders its
 * empty state.
 */
export function useLoadOnce<T>(command: string, enabled: boolean) {
  const [items, setItems] = useState<T[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setItems(await call<T[]>(command));
    } catch (err) {
      logError(command, err);
    } finally {
      setLoaded(true);
    }
  }, [command]);

  useEffect(() => {
    if (enabled && !loaded) void refresh();
  }, [enabled, loaded, refresh]);

  return { items, setItems, loaded, refresh };
}
