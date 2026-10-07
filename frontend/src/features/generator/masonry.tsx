import { Fragment, type ReactNode } from "react";

/**
 * Round-robin masonry: items flow into `cols` columns in order, so each card
 * keeps its natural height and no row-sync gaps appear. Cheaper than a real
 * column-balancing pass and visually identical for a uniformly-shaped list.
 */
export function Masonry<T>({
  cols,
  items,
  keyOf,
  render,
}: {
  cols: number;
  items: T[];
  keyOf: (item: T) => string;
  render: (item: T) => ReactNode;
}) {
  const columns: T[][] = Array.from({ length: Math.max(1, cols) }, () => []);
  for (const [i, item] of items.entries()) columns[i % columns.length].push(item);
  return (
    <div className="flex items-start gap-2">
      {columns.map((col, ci) => (
        // Keyed on the column's first item so re-sorting keeps the right card
        // state; an empty column (fewer items than columns) falls back to its
        // position, which is the only case where one is needed.
        <div className="flex min-w-0 flex-1 flex-col gap-2" key={col.length > 0 ? keyOf(col[0]) : `empty-${ci}`}>
          {col.map((item) => (
            <Fragment key={keyOf(item)}>{render(item)}</Fragment>
          ))}
        </div>
      ))}
    </div>
  );
}
