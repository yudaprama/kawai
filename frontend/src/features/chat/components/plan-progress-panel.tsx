import { CheckCircle2Icon, ChevronDownIcon, CircleIcon, CircleXIcon, FileTextIcon, LoaderCircleIcon, SkipForwardIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { emitOpenPreview } from "@/lib/preview-bridge";
import type { SupervisorArtifact, SupervisorStatus, SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";

function StepIcon({ state }: { state: SupervisorStep["state"] }) {
  if (state === "completed") return <CheckCircle2Icon className="size-3.5 shrink-0 text-emerald-500" />;
  if (state === "failed") return <CircleXIcon className="text-destructive size-3.5 shrink-0" />;
  if (state === "running") return <LoaderCircleIcon className="size-3.5 shrink-0 animate-spin text-blue-500" />;
  if (state === "skipped") return <SkipForwardIcon className="text-muted-foreground size-3.5 shrink-0" />;
  return <CircleIcon className="text-muted-foreground/50 size-3.5 shrink-0" />;
}

function ArtifactRow({ artifact }: { artifact: SupervisorArtifact }) {
  if (artifact.kind === "file") {
    return (
      <button
        className="text-primary inline-flex items-center gap-1 hover:underline"
        onClick={() => artifact.handle && emitOpenPreview(artifact.handle, artifact.filename ?? artifact.handle)}
        type="button"
      >
        <FileTextIcon className="size-3" />
        {artifact.filename ?? artifact.handle}
      </button>
    );
  }
  if (artifact.kind === "structured") {
    return <StructuredArtifact />;
  }
  if (artifact.kind === "handle") {
    return (
      <span className="text-muted-foreground font-mono text-[11px]">
        handle: {artifact.handle ?? "?"}
      </span>
    );
  }
  return null;
}

/** Structured results render as compact expandable JSON — never inline the
 *  full body into the step row. */
function StructuredArtifact() {
  return (
    <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
      <ChevronDownIcon className="size-3" />
      structured result
    </span>
  );
}

export interface PlanProgressPanelProps {
  status: SupervisorStatus;
  goal: string | null;
  steps: SupervisorStep[];
  error: string | null;
  finalOutput: string | null;
  onStop: () => void;
}

/** Live plan view: full step structure (tool, task, dependencies) with
 *  per-step status and artifacts. Steps that can run in parallel are the
 *  ones simultaneously `running` — no artificial sequencing is shown. */
export function PlanProgressPanel({ status, goal, steps, error, finalOutput, onStop }: PlanProgressPanelProps) {
  const [showOutput, setShowOutput] = useState(false);
  if (status === "idle") return null;

  const completed = steps.filter((s) => s.state === "completed").length;
  const runningCount = steps.filter((s) => s.state === "running").length;

  return (
    <div className="bg-card mx-4 mt-3 rounded-md border p-3 text-sm">
      <div className="flex items-center gap-2">
        <span className="font-medium">Plan</span>
        <span className="text-muted-foreground text-xs">
          {status === "running" && runningCount > 1 ? `running · ${runningCount} parallel · ${completed}/${steps.length}` : `${status} · ${completed}/${steps.length}`}
        </span>
        {(status === "running" || status === "awaitingConfirmation") && (
          <Button className="ml-auto" onClick={onStop} size="sm" variant="outline">
            Stop plan
          </Button>
        )}
      </div>
      {goal && <p className="text-muted-foreground mt-1 truncate text-xs">{goal}</p>}

      {steps.length > 0 && (
        <ol className="mt-2 space-y-1.5">
          {steps.map((step) => (
            <li className="flex items-start gap-2 text-xs" key={step.stepId}>
              <span className="pt-0.5">
                <StepIcon state={step.state} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{step.stepId}</span>
                  {step.tool && (
                    <span className="bg-muted rounded px-1 py-px font-mono text-[10px]">{step.tool}</span>
                  )}
                  {step.dependsOn.length > 0 && (
                    <span className="text-muted-foreground text-[10px]">after {step.dependsOn.join(", ")}</span>
                  )}
                </div>
                {step.task && <p className="text-muted-foreground mt-0.5 line-clamp-2 text-[11px]">{step.task}</p>}
                {step.output && (
                  <p className="text-muted-foreground mt-0.5 truncate text-[11px]" title={step.output}>
                    {step.output.length > 160 ? `${step.output.slice(0, 159)}…` : step.output}
                  </p>
                )}
                {step.error && <p className="text-destructive mt-0.5 text-[11px]">{step.error}</p>}
                {step.artifacts.length > 0 && (
                  <div className="mt-1 flex flex-wrap items-center gap-2">
                    {step.artifacts.map((a, i) => (
                      <ArtifactRow artifact={a} key={`${step.stepId}-artifact-${i}`} />
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
        <div className="mt-2">
          <button
            className="text-muted-foreground inline-flex items-center gap-1 text-xs hover:underline"
            onClick={() => setShowOutput((v) => !v)}
            type="button"
          >
            <ChevronDownIcon className={`size-3 transition-transform ${showOutput ? "rotate-180" : ""}`} />
            Final output
          </button>
          {showOutput && (
            <div className="bg-muted mt-1 rounded p-2 text-xs whitespace-pre-wrap">{finalOutput}</div>
          )}
        </div>
      )}
    </div>
  );
}
