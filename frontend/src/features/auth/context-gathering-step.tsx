import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useOnboarding, type OnboardingEvent } from "@/hooks/use-onboarding";

const QUICK_QUESTIONS = [
  { key: "name", question: "What's your name?" },
  { key: "role", question: "What do you do? (role / focus)" },
  { key: "goal", question: "What would you like Kawai to help with first?" },
] as const;

/**
 * Post-auth context gathering (PLAN-personal-context §2.3): a one-time,
 * fully skippable opt-in step. Three quick questions + an optional public
 * GitHub username → the agent starts with usable identity context. Rendered
 * between the auth gate and the app; never shown again after finish/skip.
 */
export function ContextGatheringStep({ children }: { children: React.ReactNode }) {
  const onboarding = useOnboarding();
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [github, setGithub] = useState("");
  const [dismissed, setDismissed] = useState(false);

  // Not yet known → render children rather than flashing the step.
  if (onboarding.loading || onboarding.status == null) return <>{children}</>;
  // Completed, skipped, errored-out, or user closed it → straight in.
  if (onboarding.status.completed || onboarding.done || dismissed) return <>{children}</>;

  const start = async () => {
    await onboarding.run({
      questions: QUICK_QUESTIONS.map(({ question, key }) => ({
        question,
        answer: (answers[key] ?? "").trim(),
      })).filter((qa) => qa.answer.length > 0),
      githubUsername: github.trim() || undefined,
    });
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6">
      <div className="w-full max-w-lg space-y-6">
        <div className="space-y-1.5 text-center">
          <h1 className="text-2xl font-semibold text-foreground">Make Kawai yours</h1>
          <p className="text-muted-foreground text-sm">
            Answer what you like — every field is optional. Kawai uses this to know who you are
            before your first goal. You can always change it later in Memory.
          </p>
        </div>

        {!onboarding.running && onboarding.events.length === 0 ? (
          <div className="space-y-3 rounded-lg border p-4">
            {QUICK_QUESTIONS.map(({ key, question }) => (
              <div key={key} className="grid gap-1">
                <label className="text-sm font-medium" htmlFor={`ob-${key}`}>
                  {question}
                </label>
                <Input
                  id={`ob-${key}`}
                  onChange={(e) => setAnswers((prev) => ({ ...prev, [key]: e.target.value }))}
                  value={answers[key] ?? ""}
                />
              </div>
            ))}
            <div className="grid gap-1">
              <label className="text-sm font-medium" htmlFor="ob-github">
                Public GitHub username <span className="text-muted-foreground font-normal">(optional)</span>
              </label>
              <Input
                id="ob-github"
                onChange={(e) => setGithub(e.target.value)}
                placeholder="octocat"
                value={github}
              />
            </div>
          </div>
        ) : (
          <RunLog events={onboarding.events} running={onboarding.running} />
        )}

        <div className="flex items-center justify-center gap-2">
          {onboarding.running ? (
            <Button disabled size="sm">
              <Spinner className="size-3" /> Working…
            </Button>
          ) : (
            !onboarding.done && (
              <>
                <Button onClick={() => void start()} size="sm">
                  Continue
                </Button>
                <Button onClick={() => void onboarding.skip()} size="sm" variant="ghost">
                  Skip for now
                </Button>
              </>
            )
          )}
          {(onboarding.done || onboarding.events.some((e) => e.type === "onboardingError")) && (
            <Button onClick={() => setDismissed(true)} size="sm" variant="outline">
              Enter Kawai
            </Button>
          )}
        </div>
      </div>
    </main>
  );
}

function RunLog({ events, running }: { events: OnboardingEvent[]; running: boolean }) {
  return (
    <ol className="space-y-1.5 rounded-lg border p-4 font-mono text-xs">
      {events.map((e, i) => (
        <li className="text-muted-foreground" key={i}>
          {e.type === "sourceStarted" && <>→ gathering {e.source}…</>}
          {e.type === "sourceProgress" && <>  {e.source}: {e.note}</>}
          {e.type === "sourceCompleted" && <>✓ {e.source}</>}
          {e.type === "compressStarted" && <>→ distilling profile…</>}
          {e.type === "profileReady" && (
            <>
              ✓ {e.profile} profile · {e.people} people · {e.goals} goals
            </>
          )}
          {e.type === "onboardingFinished" && <>✓ done — {e.totalItems} memories saved</>}
          {e.type === "onboardingError" && <span className="text-destructive">✗ {e.message}</span>}
        </li>
      ))}
      {running && (
        <li className="flex items-center gap-1.5">
          <Spinner className="size-3" />
        </li>
      )}
    </ol>
  );
}
