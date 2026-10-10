import { useCallback, useEffect, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** How long an armed destructive control waits for its confirming click. */
const ARM_WINDOW_MS = 3000;

/**
 * The arm/lapse state machine behind every two-step destructive action in the
 * app (delete a memory, forget a facet, delete a skill, a knowledge file, a
 * SQL profile).
 *
 * `click(id)` is the whole interaction: the first call for a given row arms
 * it, a second inside the window commits, and the arm lapses on its own so a
 * stray click can't sit primed. `armedId` names the ONE armed row — arming is
 * per-row, so a pending delete never makes a sibling look destructive, and a
 * second click somewhere else re-arms rather than double-firing the first.
 *
 * Owning this here is what lets the render side be presentational: a caller
 * that already holds the id (the shared knowledge actions, which arm from a
 * hook several rows deep) passes `armed`/`onClick` straight through, and one
 * that doesn't wraps its delete in this hook.
 */
export function useArmedConfirm(commit: (id: string) => unknown) {
  const [armedId, setArmedId] = useState<string | null>(null);

  useEffect(() => {
    if (armedId == null) return;
    const timer = setTimeout(() => setArmedId(null), ARM_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [armedId]);

  const click = useCallback(
    async (id: string) => {
      if (armedId !== id) {
        setArmedId(id);
        return;
      }
      setArmedId(null);
      await commit(id);
    },
    [armedId, commit],
  );

  const isArmed = useCallback((id: string) => armedId === id, [armedId]);

  return { armedId, isArmed, click };
}

/**
 * The labelled form: a full `Button` whose content swaps to the confirm label
 * while armed.
 *
 * The swap is the point. An arm signalled only by a `title` tooltip is
 * invisible to anyone not hovering and to every touch user, so the control
 * reads as "nothing happened" and the second tap lands on an unremarkable
 * button. Revealing the label costs a few pixels and makes the pending state
 * self-evident.
 */
export function ConfirmButton({
  armed,
  confirmLabel,
  icon,
  label,
  onClick,
  size = "xs",
  variant = "outline",
}: {
  armed: boolean;
  /** Content and tooltip while armed — should read as the committing action. */
  confirmLabel: string;
  /** Optional leading icon, shown in BOTH states so the button keeps its width. */
  icon?: string;
  /** Content and tooltip while idle. */
  label: string;
  onClick: () => void;
  size?: "xs" | "sm" | "icon-sm";
  variant?: "outline" | "ghost";
}) {
  return (
    <Button
      className={armed ? "" : "text-destructive hover:text-destructive"}
      onClick={onClick}
      size={size}
      title={armed ? confirmLabel : label}
      variant={variant}
    >
      {icon && <Icon className="size-3" name={icon} />}
      {armed ? confirmLabel : label}
    </Button>
  );
}

/**
 * The icon-only form, for dense rows where a permanent label has nowhere to
 * go. Armed, it turns destructive and grows the confirm label beside the icon,
 * so the pending state is still visible rather than tooltip-only.
 */
export function ConfirmIconButton({
  armed,
  confirmLabel,
  icon,
  label,
  onClick,
}: {
  armed: boolean;
  confirmLabel: string;
  icon: string;
  /** Accessible name while idle. */
  label: string;
  onClick: () => void;
}) {
  return (
    <span className="flex shrink-0 items-center">
      {armed && <span className="text-destructive mr-1 text-[11px] whitespace-nowrap">{confirmLabel}</span>}
      <button
        aria-label={armed ? confirmLabel : label}
        aria-pressed={armed}
        className={cn("rounded p-1", armed ? "text-destructive" : "text-muted-foreground hover:text-destructive")}
        onClick={onClick}
        title={armed ? confirmLabel : label}
        type="button"
      >
        <Icon className="size-3.5" name={icon} />
      </button>
    </span>
  );
}
