import { useEffect, type RefObject } from "react";

/**
 * Close a dropdown/panel when the user clicks outside of it.
 * Uses `composedPath()` so clicks inside shadow DOM portals still count.
 */
export function useClickOutside(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
) {
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const path = event.composedPath();
      if (ref.current && !path.includes(ref.current)) {
        onClose();
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [ref, onClose]);
}
