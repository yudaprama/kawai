/** Shared Escape arbitration for window-level keydown handlers.
 *
 *  True when a topmost overlay should OWN Escape — a dialog, menu, listbox,
 *  or any Radix popper container (dropdowns/popovers render their content
 *  into `[data-radix-popper-content-wrapper]`). The overlay's own handler
 *  closes it, so page-level handlers must stand down: on the workbench, an
 *  Esc that dismisses the avatar dropdown or a popover must never arm the
 *  two-step run stop.
 *
 *  Deliberately NOT matched here:
 *  - `[data-open-drawer]` — the App's nav-drawer handler keys on it and must
 *    keep running (page handlers keep their own early return for it).
 *  - tooltips — they don't consume Escape, so they never block it. */
export function overlayOwnsEscape(): boolean {
  return (
    document.querySelector('[role="dialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]') !=
    null
  );
}
