import { useCallback, useEffect, useRef, useState } from "react";
import { call, errText } from "@/lib/api";
import { streamOperation } from "@/lib/stream";
import { showErrorToast } from "@/lib/utils";
import { useOp } from "@/hooks/use-op";

/** Mirrors the Rust `OnboardingStatus` (camelCase serde). */
export interface OnboardingStatus {
  completed: boolean;
  sources: string[];
}

/** Mirrors `kawai_events::OnboardingEvent` (camelCase serde tag = "type"). */
export type OnboardingEvent =
  | { type: "sourceStarted"; source: string }
  | { type: "sourceProgress"; source: string; note: string }
  | { type: "sourceCompleted"; source: string; itemsFound: number }
  | { type: "compressStarted" }
  | { type: "profileReady"; profile: number; people: number; goals: number }
  | { type: "onboardingFinished"; totalItems: number }
  | { type: "onboardingError"; message: string };

export interface QuickAnswerInput {
  question: string;
  answer: string;
}

export interface OnboardingSourcesInput {
  questions: QuickAnswerInput[];
  githubUsername?: string;
  /** Opt-in Gmail scan (read-only, Composio connection required). */
  gmail?: boolean;
}

/**
 * Onboarding gate state + run control (PLAN-personal-context §2.3).
 * `status.completed === false` ⇒ the UI may show the context-gathering step;
 * `run` streams `OnboardingEvent`s; `skip` never re-prompts.
 */
export function useOnboarding() {
  const statusOp = useOp<OnboardingStatus>("onboarding_status", {}, { onError: "log" });
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<OnboardingEvent[]>([]);
  const [done, setDone] = useState(false);
  const controlRef = useRef<ReturnType<typeof streamOperation> | null>(null);

  useEffect(() => () => controlRef.current?.cancel(), []);

  const run = useCallback(async (sources: OnboardingSourcesInput) => {
    if (running) return;
    setRunning(true);
    setEvents([]);
    controlRef.current = streamOperation<OnboardingEvent>(
      "onboarding_run",
      { sources },
      {
        onEvent: (e) => {
          setEvents((prev) => [...prev, e]);
          // The OnboardingEvent union's terminal variants are
          // `onboardingFinished`/`onboardingError` — streamOperation's
          // generic `finished`/`error` shortcut never fires for them, so
          // the terminal state transitions happen HERE. Without this the
          // spinner runs forever after the backend completes.
          if (e.type === "onboardingFinished") {
            setRunning(false);
            setDone(true);
            void statusOp.execute();
          } else if (e.type === "onboardingError") {
            setRunning(false);
            showErrorToast(e.message);
          }
        },
        onDone: () => {
          setRunning(false);
          setDone(true);
          void statusOp.execute();
        },
        onError: (err) => {
          setRunning(false);
          showErrorToast(errText(err));
        },
      },
    );
    // The invoke resolves when the stream command returns; onDone already
    // flipped the flags, this just satisfies the async contract.
  }, [running, statusOp]);

  const skip = useCallback(async () => {
    try {
      await call("onboarding_skip");
      setDone(true);
      await statusOp.execute();
    } catch (err) {
      showErrorToast(errText(err));
    }
  }, [statusOp]);

  return {
    status: statusOp.data ?? null,
    loading: statusOp.loading && statusOp.data == null,
    error: statusOp.error,
    running,
    events,
    done,
    run,
    skip,
    refresh: statusOp.execute,
  };
}
