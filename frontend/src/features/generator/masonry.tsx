import { Fragment, type ReactNode, useEffect, useState } from "react";

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

/** N columns by viewport width — `max` is the count at lg and up, half of it
 *  in the middle band, one on a phone. Shared by the image and video lanes:
 *  both size their galleries with `Masonry`. */
export function useColumnCount(max: number): number {
  const [cols, setCols] = useState(max);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 639px)");
    const medium = window.matchMedia("(max-width: 1023px)");
    const update = () => setCols(narrow.matches ? 1 : medium.matches ? Math.max(1, Math.ceil(max / 2)) : max);
    update();
    narrow.addEventListener("change", update);
    medium.addEventListener("change", update);
    return () => {
      narrow.removeEventListener("change", update);
      medium.removeEventListener("change", update);
    };
  }, [max]);
  return cols;
}
