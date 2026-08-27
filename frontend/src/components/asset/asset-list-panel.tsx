/**
 * AssetListPanel — asset-management left list panel.
 *
 * Vendored from TencentDB-Agent-Memory's MemoryPanel (MIT). The container
 * provides the panel title + count, skeleton loading, empty state, selection
 * highlighting, and the standardized 4-line item structure (name / desc /
 * badges / meta); item content arrives via render prop so the container stays
 * business-agnostic. Styles live in asset-list-panel.css (namespaced `_alp-*`,
 * themed through the --tea-* tokens defined in index.css).
 */

import type { ReactNode } from "react";
import "./asset-list-panel.css";

/* ── Panel ── */

interface AssetListPanelProps<T> {
  /** Panel title */
  title: ReactNode;
  /** Item count text */
  count?: ReactNode;
  /** Loading state (renders the skeleton list) */
  loading?: boolean;
  /** Data items */
  items: T[];
  /** Currently selected item id */
  selectedId?: string | null;
  /** Extract the unique id from an item */
  getItemId: (item: T) => string;
  /** Selection callback */
  onSelect: (item: T) => void;
  /** Render one list item's content (inside the selection wrapper) */
  renderItem: (item: T, isSelected: boolean) => ReactNode;
  /** Disable specific items */
  isItemDisabled?: (item: T) => boolean;
  /** Empty-state text */
  emptyText?: ReactNode;
}

export function AssetListPanel<T>({
  title,
  count,
  loading,
  items,
  selectedId,
  getItemId,
  onSelect,
  renderItem,
  isItemDisabled,
  emptyText,
}: AssetListPanelProps<T>) {
  return (
    <div className="_alp">
      <div className="_alp-header">
        <span className="_alp-title">{title}</span>
        {!loading && count != null && <span className="_alp-count">{count}</span>}
      </div>

      {loading ? (
        <div className="_alp-items">
          {[0, 1, 2, 3].map((i) => (
            <div className="_alp-item _alp-skeleton" key={i}>
              <div className="_alp-skeleton-line _alp-skeleton-primary" />
              <div className="_alp-skeleton-line _alp-skeleton-secondary" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="_alp-empty">{emptyText}</div>
      ) : (
        <ul className="_alp-items">
          {items.map((item) => {
            const id = getItemId(item);
            const isSelected = selectedId === id;
            const disabled = isItemDisabled?.(item) ?? false;
            return (
              <li
                className={
                  ["_alp-item", isSelected ? "_alp-item--selected" : "", disabled ? "_alp-item--disabled" : ""]
                    .filter(Boolean)
                    .join(" ") || undefined
                }
                key={id}
              >
                <button
                  className="_alp-item-btn"
                  disabled={disabled}
                  onClick={() => !disabled && onSelect(item)}
                  type="button"
                >
                  {renderItem(item, isSelected)}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── Item content — standardized 4-line structure ── */

/** Header row: primary label + optional trailing affordances */
export function AssetItemHeader({ children }: { children: ReactNode }) {
  return <div className="_alp-item-header">{children}</div>;
}

/** Name / title text */
export function AssetItemName({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span className="_alp-item-name" title={title}>
      {children}
    </span>
  );
}

/** Real asset id — de-emphasized monospace under the name */
export function AssetItemId({ children }: { children: ReactNode }) {
  return (
    <span className="_alp-item-id" title={typeof children === "string" ? children : undefined}>
      {children}
    </span>
  );
}

/** Description (2-line clamp) */
export function AssetItemDesc({ children }: { children: ReactNode }) {
  return <p className="_alp-item-desc">{children}</p>;
}

/** Badge row container */
export function AssetItemBadges({ children }: { children: ReactNode }) {
  return <div className="_alp-item-badges">{children}</div>;
}

/** Plain-text badge (icon + text) */
export function AssetBadge({ icon, children, title }: { icon?: ReactNode; children: ReactNode; title?: string }) {
  return (
    <span className="_alp-badge" title={title}>
      {icon}
      {children}
    </span>
  );
}

/** Brand-colored "you" marker */
export function AssetBadgeYou({ children }: { children: ReactNode }) {
  return <span className="_alp-badge-you">{children}</span>;
}

/** Metadata row container */
export function AssetItemMeta({ children }: { children: ReactNode }) {
  return <div className="_alp-item-meta">{children}</div>;
}

/** Right-aligned timestamp */
export function AssetItemTime({ children }: { children: ReactNode }) {
  return <span className="_alp-item-time">{children}</span>;
}
