import { BrainIcon, CheckIcon, FileTextIcon, LoaderCircleIcon, SearchIcon, SparklesIcon, UserRoundIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import type { SupervisorPlanState } from "@/features/chat/hooks/supervisor-types";

/** Full-pane planning stage — shown in the deliverable viewer while
 *  `plan_task` runs, so the longest (and otherwise silent) phase of a run
 *  plays out on the biggest surface instead of one static sidebar line.
 *  Everything here is driven by planning* SupervisorEvents; nothing new is
 *  fetched. */

type Planning = NonNullable<SupervisorPlanState["planning"]>;

function Stage({
  state,
  label,
}: {
  state: "done" | "active" | "pending";
  label: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 font-mono text-xs",
        state === "done" && "text-muted-foreground",
        state === "active" && "text-foreground",
        state === "pending" && "text-muted-foreground/40",
      )}
    >
      {state === "done" ? (
        <CheckIcon className="text-success size-3.5" />
      ) : state === "active" ? (
        <LoaderCircleIcon className="text-primary size-3.5 animate-spin" />
      ) : (
        <span className="size-3.5 rounded-full border border-current" />
      )}
      {label}
    </div>
  );
}

export function PlanningCanvas({ planning }: { planning: Planning }) {
  const { round, searching, tools, queries, activity, context } = planning;
  // Stage derivation: round 1 opens with searching=true; the first
  // non-searching round is the final plan-writing call.
  const analyzing: "done" | "active" = round > 1 || tools.length > 0 ? "done" : "active";
  const searchState = !searching && round > 0 ? "done" : analyzing === "done" ? "active" : "pending";
  const writingState = !searching ? "active" : "pending";

  return (
    <div className="border-primary/20 bg-card flex flex-1 flex-col justify-center rounded-lg border p-8">
      <div className="mb-6 flex items-center gap-3">
        <LoaderCircleIcon className="text-primary size-5 animate-spin" />
        <div>
          <div className="text-foreground font-mono text-sm font-bold">Planning run</div>
          <div className="text-muted-foreground font-mono text-[11px]">
            round {round}
            {planning.provider ? ` · ${planning.provider}` : ""}
          </div>
        </div>
      </div>

      <div className="space-y-2.5">
        <Stage state={analyzing} label="Analyzing your goal" />
        <Stage state={searchState} label="Searching the tool catalog" />
        <Stage state={writingState} label="Writing the plan" />
      </div>

      {queries.length > 0 && (
        <div className="text-muted-foreground/80 mt-6 space-y-1">
          {queries.slice(-2).map((q) => (
            <div key={q} className="flex items-center gap-1.5 font-mono text-[11px] italic">
              <SearchIcon className="size-3 shrink-0" />
              <span className="truncate">“{q}”</span>
            </div>
          ))}
        </div>
      )}

      {tools.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {tools.slice(0, 8).map((t) => (
            <span
              key={t}
              className="bg-primary/10 text-primary rounded px-1.5 py-0.5 font-mono text-[10px]"
            >
              {t}
            </span>
          ))}
          {tools.length > 8 && (
            <span className="text-muted-foreground font-mono text-[10px]">+{tools.length - 8}</span>
          )}
        </div>
      )}

      {context && (context.persona || context.memories > 0 || context.skills > 0 || context.files > 0) && (
        <div className="text-muted-foreground mt-6 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[11px]">
          {context.persona && (
            <span className="inline-flex items-center gap-1">
              <UserRoundIcon className="size-3" /> persona
            </span>
          )}
          {context.memories > 0 && (
            <span className="inline-flex items-center gap-1">
              <BrainIcon className="size-3" /> {context.memories} memories
            </span>
          )}
          {context.skills > 0 && (
            <span className="inline-flex items-center gap-1">
              <SparklesIcon className="size-3" /> {context.skills} skills
            </span>
          )}
          {context.files > 0 && (
            <span className="inline-flex items-center gap-1">
              <FileTextIcon className="size-3" /> {context.files} files
            </span>
          )}
        </div>
      )}

      {activity && (
        <div className="text-muted-foreground/60 mt-6 line-clamp-2 font-mono text-[11px] italic">
          ⌁ {activity}
        </div>
      )}
    </div>
  );
}
