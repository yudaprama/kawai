import { useMemo, useState } from "react";

/**
 * Shared state for asset list pages: query filter + item selection.
 * Each page supplies its own filter function and items list.
 */
export function useAssetPage<TItem extends { id: string | number }, TValue extends string | number>({
  items,
  filterFn,
}: {
  items: TItem[];
  filterFn: (item: TItem, query: string) => boolean;
}) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<TValue | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((s) => filterFn(s, q));
  }, [items, query, filterFn]);

  const active = filtered.find((s) => s.id === selectedId) ?? items.find((s) => s.id === selectedId) ?? null;
  const activeId = (active?.id ?? null) as TValue | null;

  return { query, setQuery, selectedId, setSelectedId, filtered, active, activeId };
}
