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
 *  when a quote is armed — chips arm the default (previous deliverable),
 *  an explicit "build on this" pick arms a specific past run. ✕ disarms
 *  whichever is active. */
export function ComposerQuoteBadge({ workbench }: { workbench: ReturnType<typeof useWorkbench> }) {
  if (!workbench.composing) return null;
  const target = workbench.quoteTarget;
  if (!workbench.followUp && target == null) return null;
  const title = target?.goal ?? (workbench.supervisor.goal ?? "previous deliverable");
  const runNum = target != null ? workbench.runs.findIndex((r) => r.id === target.id) + 1 : 0;
  const label =
    target != null && runNum > 0 ? `Will include: Run ${runNum} — “${title}”` : "Will include the previous deliverable";
  return (
    <div className="text-muted-foreground mb-2 flex items-center gap-1.5 font-mono text-[11px]">
      <CornerDownRightIcon className="size-3 shrink-0" />
      <span
        className="min-w-0 truncate"
        title={
          target != null && runNum > 0
            ? `Will include the deliverable of Run ${runNum}: “${title}”`
            : `Will include: “${title}” (previous deliverable)`
        }
      >
        {label}
      </span>
      <button
        aria-label="Do not include the deliverable"
        className="hover:text-foreground shrink-0"
        onClick={() => {
          workbench.setFollowUp(false);
          workbench.setQuoteTarget(null);
        }}
        type="button"
      >
        <XIcon className="size-3" />
      </button>
    </div>
  );
}
