import { useCallback, useEffect, useRef, useState } from "react";
import { call, errText } from "@/lib/api";
import { streamOperation } from "@/lib/stream";
import { showErrorToast } from "@/lib/utils";
import { useOp } from "@/hooks/use-op";
import type { OnboardingSources, OnboardingStatus } from "@/generated/api-types";
import type { OnboardingEvent } from "@/generated/events";

/** Wire status, event union, and run arguments — generated from
 *  `kawai_api_types::*` and `kawai_events::OnboardingEvent` by
 *  `bun run generate:events`; never hand-edited. Re-exported so
 *  existing import paths keep working. */
export type { OnboardingStatus, OnboardingEvent };
export type OnboardingSourcesInput = OnboardingSources;
export type { OnboardingSources };

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

  const run = useCallback(
    async (sources: OnboardingSourcesInput) => {
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
            switch (e.type) {
              case "onboardingFinished":
                setRunning(false);
                setDone(true);
                void statusOp.execute();
                break;
              case "onboardingError":
                setRunning(false);
                showErrorToast(e.message);
                break;
              // Progress-tier variants are logged (above) but change no state.
              case "sourceStarted":
              case "sourceProgress":
              case "sourceCompleted":
              case "compressStarted":
              case "profileReady":
                break;
              default: {
                // Exhaustiveness guard: an unhandled variant must be
                // classified above — this fails `tsc` instead of dropping it.
                const _unhandled: never = e;
                void _unhandled;
                break;
              }
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
    },
    [running, statusOp],
  );

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
