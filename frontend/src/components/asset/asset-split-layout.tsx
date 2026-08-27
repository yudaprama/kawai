/**
 * AssetSplitLayout — resizable split view for asset-management pages.
 *
 * Vendored from TencentDB-Agent-Memory's MemoryPanel (MIT):
 * - left sidebar width is drag-adjustable, persisted to localStorage per
 *   storageKey so it survives reloads
 * - both columns fill the height and scroll internally; the outer page never
 *   grows a scrollbar
 * - the drag handle is keyboard accessible (← / → arrows, 16px steps)
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import "./asset-split-layout.css";

interface AssetSplitLayoutProps {
  sidebar: ReactNode;
  detail: ReactNode;
  /** Persistence key for the dragged sidebar width; omit to disable. */
  storageKey?: string;
}

const MIN_SIDEBAR = 220;
const MAX_SIDEBAR = 480;
const DEFAULT_SIDEBAR = 280;

function clampWidth(w: number): number {
  return Math.min(MAX_SIDEBAR, Math.max(MIN_SIDEBAR, w));
}

function readStoredWidth(storageKey?: string): number {
  if (!storageKey) return DEFAULT_SIDEBAR;
  try {
    const raw = window.localStorage.getItem(storageKey);
    const parsed = raw ? Number(raw) : Number.NaN;
    return Number.isFinite(parsed) ? clampWidth(parsed) : DEFAULT_SIDEBAR;
  } catch {
    return DEFAULT_SIDEBAR;
  }
}

export function AssetSplitLayout({ sidebar, detail, storageKey }: AssetSplitLayoutProps) {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => readStoredWidth(storageKey));
  const [dragging, setDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // While dragging: width follows the pointer relative to the container's
  // left edge, clamped to [MIN, MAX].
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      setSidebarWidth(clampWidth(e.clientX - rect.left));
    };
    const onUp = () => setDragging(false);
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    // Suppress text selection while dragging so list content isn't highlighted.
    const prevUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.userSelect = prevUserSelect;
    };
  }, [dragging]);

  // Persist the final width when the drag ends.
  useEffect(() => {
    if (dragging || !storageKey) return;
    try {
      window.localStorage.setItem(storageKey, String(sidebarWidth));
    } catch {
      /* localStorage unavailable — only persistence is lost */
    }
  }, [dragging, sidebarWidth, storageKey]);

  const onHandleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setDragging(true);
  }, []);

  return (
    <div
      className={dragging ? "_asset-split _asset-split--dragging" : "_asset-split"}
      ref={containerRef}
      style={{ gridTemplateColumns: `${sidebarWidth}px 6px minmax(0, 1fr)` }}
    >
      <section className="_asset-split-sidebar">{sidebar}</section>
      <button
        aria-label="Resize sidebar"
        className="_asset-split-resizer"
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft") {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w - 16));
          } else if (e.key === "ArrowRight") {
            e.preventDefault();
            setSidebarWidth((w) => clampWidth(w + 16));
          }
        }}
        onMouseDown={onHandleMouseDown}
        type="button"
      >
        <span className="_asset-split-resizer-bar" />
      </button>
      <section className="_asset-split-detail">{detail}</section>
    </div>
  );
}
