import {
  CheckCircle2Icon,
  ChevronDownIcon,
  CircleIcon,
  CircleXIcon,
  FileTextIcon,
  LoaderCircleIcon,
  SkipForwardIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { emitOpenPreview } from "@/lib/preview-bridge";
import type { SupervisorArtifact, SupervisorStatus, SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";

function StepIcon({ state }: { state: SupervisorStep["state"] }) {
  // Token-driven colors only — raw palette classes bypass the theme and break
  // dark-mode contrast (see critique 2026-09-04).
  if (state === "completed") return <CheckCircle2Icon className="text-success size-3.5 shrink-0" />;
  if (state === "failed") return <CircleXIcon className="text-destructive size-3.5 shrink-0" />;
  if (state === "running") return <LoaderCircleIcon className="text-primary size-3.5 shrink-0 animate-spin" />;
  if (state === "skipped") return <SkipForwardIcon className="text-muted-foreground size-3.5 shrink-0" />;
  return <CircleIcon className="text-muted-foreground/50 size-3.5 shrink-0" />;
}

function ArtifactRow({ artifact }: { artifact: SupervisorArtifact }) {
  if (artifact.kind === "file") {
    return (
      <button
        className="text-primary inline-flex items-center gap-1 rounded-sm text-xs font-medium hover:underline"
        onClick={() => artifact.handle && emitOpenPreview(artifact.handle, artifact.filename ?? artifact.handle)}
        type="button"
      >
        <FileTextIcon className="size-3" />
        {artifact.filename ?? artifact.handle}
      </button>
    );
  }
  if (artifact.kind === "structured") {
    // Plain metadata — no chevron: nothing expands (a chevron implies an
    // interaction that doesn't exist).
    return <span className="text-muted-foreground text-[11px]">structured result</span>;
  }
  if (artifact.kind === "handle") {
    return <span className="text-muted-foreground font-mono text-[11px]">handle: {artifact.handle ?? "?"}</span>;
  }
  return null;
}

export interface PlanProgressPanelProps {
  status: SupervisorStatus;
  goal: string | null;
  steps: SupervisorStep[];
  error: string | null;
  finalOutput: string | null;
  onStop: () => void;
}

const STATUS_LABEL: Record<SupervisorStatus, string> = {
  idle: "idle",
  running: "running",
  awaitingConfirmation: "waiting for your approval",
  completed: "completed",
  failed: "failed",
};

/** Live plan view: full step structure (tool, task, dependencies) with
 *  per-step status and artifacts. Steps that can run in parallel are the
 *  ones simultaneously `running` — no artificial sequencing is shown. */
export function PlanProgressPanel({ status, goal, steps, error, finalOutput, onStop }: PlanProgressPanelProps) {
  const [showOutput, setShowOutput] = useState(false);
  if (status === "idle") return null;

  const completed = steps.filter((s) => s.state === "completed").length;
  const failed = steps.filter((s) => s.state === "failed").length;
  const runningCount = steps.filter((s) => s.state === "running").length;
  const done = completed + failed + steps.filter((s) => s.state === "skipped").length;
  const progress = steps.length > 0 ? Math.round((done / steps.length) * 100) : 0;

  return (
    <div className="bg-card mx-4 mt-3 rounded-xl border p-3.5 text-sm shadow-xs">
      <div className="flex items-center gap-2.5">
        <span className="text-sm font-semibold">Plan</span>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${
            status === "failed"
              ? "bg-destructive/10 text-destructive"
              : status === "completed"
                ? "bg-success/10 text-success"
                : "bg-primary/10 text-primary"
          }`}
        >
          {status === "running" && <LoaderCircleIcon className="size-3 animate-spin" />}
          {STATUS_LABEL[status]}
          {steps.length > 0 && ` · ${completed}/${steps.length}`}
          {status === "running" && runningCount > 1 && ` · ${runningCount} parallel`}
        </span>
        {(status === "running" || status === "awaitingConfirmation") && (
          <Button className="ml-auto" onClick={onStop} size="sm" variant="outline">
            Stop plan
          </Button>
        )}
      </div>

      {/* Progress rail — the at-a-glance signal the text counters alone lacked. */}
      {steps.length > 0 && (
        <div
          aria-label={`Plan progress: ${completed} of ${steps.length} steps completed`}
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={progress}
          className="bg-muted mt-2.5 h-1 overflow-hidden rounded-full"
          role="progressbar"
        >
          <div
            className={`h-full rounded-full transition-all duration-500 ease-out ${
              status === "failed" ? "bg-destructive" : "bg-primary"
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      {goal && <p className="mt-2.5 line-clamp-2 text-sm leading-snug">{goal}</p>}

      {steps.length > 0 && (
        <ol className="mt-3 space-y-1">
          {steps.map((step) => (
            <li
              className={`flex items-start gap-2.5 rounded-md text-xs ${
                step.state === "running" ? "-mx-2 bg-primary/5 px-2 py-1.5" : "px-0 py-1"
              }`}
              key={step.stepId}
            >
              <span className="pt-0.5">
                <StepIcon state={step.state} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{step.stepId}</span>
                  {step.tool && <span className="bg-muted rounded px-1 py-px font-mono text-[11px]">{step.tool}</span>}
                  {step.dependsOn.length > 0 && (
                    <span className="text-muted-foreground text-[11px]">after {step.dependsOn.join(", ")}</span>
                  )}
                </div>
                {step.task && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">{step.task}</p>}
                {step.output && (
                  <p className="text-foreground/80 mt-0.5 truncate text-[11px]" title={step.output}>
                    {step.output.length > 160 ? `${step.output.slice(0, 159)}…` : step.output}
                  </p>
                )}
                {step.error && <p className="text-destructive mt-0.5 text-[11px]">{step.error}</p>}
                {step.artifacts.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {step.artifacts.map((a) => (
                      <ArtifactRow artifact={a} key={`${step.stepId}-${a.handle ?? a.kind}`} />
                    ))}
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}

      {error && <p className="text-destructive mt-2 text-xs">{error}</p>}
      {finalOutput && (
        <div className="mt-2.5 border-t pt-2">
          <button
            className="text-muted-foreground inline-flex items-center gap-1 text-xs font-medium hover:underline"
            onClick={() => setShowOutput((v) => !v)}
            type="button"
          >
            <ChevronDownIcon className={`size-3 transition-transform ${showOutput ? "rotate-180" : ""}`} />
            Final output
          </button>
          {showOutput && (
            <div className="bg-muted mt-1.5 rounded-md p-2.5 text-xs whitespace-pre-wrap">{finalOutput}</div>
          )}
        </div>
      )}
    </div>
  );
}
