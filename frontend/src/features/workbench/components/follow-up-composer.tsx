import { CornerDownRightIcon, XIcon } from "lucide-react";

import { FOLLOW_UP_CHIPS, type useWorkbench } from "@/features/workbench/hooks/use-workbench";

/** Quick-action chips above the composer — static set until the dynamic
 *  suggest_followups result lands, then swapped (statis-first, Fase 3).
 *  Only rendered after a finished run with a completed deliverable; chips
 *  never block free-form input and disappear while a plan is under review. */
export function FollowUpChips({
  workbench,
  onChip,
}: {
  workbench: ReturnType<typeof useWorkbench>;
  onChip: (text: string) => void;
}) {
  if (!workbench.canFollowUp || !workbench.composing) return null;
  const chips: { icon?: string; label: string; text: string }[] =
    workbench.dynamicChips.length > 0
      ? workbench.dynamicChips.map((t) => ({ label: t, text: t }))
      : FOLLOW_UP_CHIPS.map((c) => ({ icon: c.icon, label: c.label, text: c.prefix }));
  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {chips.map((c) => (
        <button
          className="border-border/60 hover:border-primary/60 text-foreground/80 hover:text-foreground inline-flex items-center gap-1 rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors"
          key={c.label}
          onClick={() => onChip(c.text)}
          title={c.text}
          type="button"
        >
          {c.icon && <span aria-hidden>{c.icon}</span>}
          {c.label}
        </button>
      ))}
    </div>
  );
}

/** The single quote indicator (PLAN-workbench-multi-run-ux.md): rendered
 *  ONLY when a quote is armed — chips are the only way to arm it, ✕ disarms.
 *  No second opt-in entry point. */
export function ComposerQuoteBadge({ workbench }: { workbench: ReturnType<typeof useWorkbench> }) {
  if (!workbench.followUp || !workbench.composing) return null;
  const title = workbench.supervisor.goal ?? "previous deliverable";
  return (
    <div className="text-muted-foreground mb-2 flex items-center gap-1.5 font-mono text-[11px]">
      <CornerDownRightIcon className="size-3 shrink-0" />
      <span className="min-w-0 truncate" title={`Will include: “${title}” (previous deliverable)`}>
        Will include the previous deliverable
      </span>
      <button
        aria-label="Do not include the previous deliverable"
        className="hover:text-foreground shrink-0"
        onClick={() => workbench.setFollowUp(false)}
        type="button"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
