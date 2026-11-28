/**
 * The Workbench's back stack, pure so its ORDER is testable.
 *
 * App forwards the Android hardware back here (and the on-screen back arrow
 * calls the same landing step). The layers are walked innermost first:
 *
 *   mobile progress rail → run view → landing
 *
 * Two orderings are load-bearing and easy to break by accident:
 * - the drawer overlays whatever is under it, so closing it always wins —
 *   including on the landing, where a stale flag must never swallow the press;
 * - a run in flight owns the run view (the arrow is disabled for the same
 *   reason), so the press is REFUSED rather than exiting or going home: the
 *   run's progress must stay on screen.
 */
export type BackStep =
  /** Close the mobile progress-rail drawer. */
  | "closeRail"
  /** Leave the run view for the landing composer (session + runs stay). */
  | "goHome"
  /** A run owns the screen — consume the press and say why. */
  | "blocked"
  /** Landing: nothing left to close on this page. */
  | "none";

export function nextBackStep({
  mobileRail,
  home,
  runBusy,
}: {
  /** The mobile progress rail is open (drawer over the canvas). */
  mobileRail: boolean;
  /** The landing composer is showing (the page's root). */
  home: boolean;
  /** Planning, running, stopping, awaiting confirmation, or under review. */
  runBusy: boolean;
}): BackStep {
  if (mobileRail) return "closeRail";
  if (home) return "none";
  if (runBusy) return "blocked";
  return "goHome";
}
