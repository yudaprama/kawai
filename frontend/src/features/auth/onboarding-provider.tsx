import { createContext, useContext, useState, type ReactNode } from "react";
import {
  useOnboarding,
  type OnboardingEvent,
  type OnboardingSourcesInput,
  type OnboardingStatus,
} from "@/hooks/use-onboarding";

interface OnboardingContextValue {
  status: OnboardingStatus | null;
  loading: boolean;
  error: string | null;
  running: boolean;
  events: OnboardingEvent[];
  done: boolean;
  /** The user chose to proceed into the app while the pipeline runs. */
  entered: boolean;
  refresh: () => Promise<void>;
  run: (sources: OnboardingSourcesInput) => Promise<void>;
  skip: () => Promise<void>;
  enterApp: () => void;
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null);

/**
 * Owns the onboarding state at the app root so the run stream SURVIVES the
 * full-screen step unmounting — pressing Continue drops the user straight
 * into the app while the pipeline (search + scrape + compress) keeps
 * running in the background; a small indicator card surfaces progress.
 */
export function OnboardingProvider({ children }: { children: ReactNode }) {
  const onboarding = useOnboarding();
  const [entered, setEntered] = useState(false);

  const run = async (sources: OnboardingSourcesInput) => {
    setEntered(true); // unblock the UI immediately; progress moves to the card
    await onboarding.run(sources);
  };

  const refresh = async () => {
    await onboarding.refresh();
  };

  return (
    <OnboardingContext.Provider
      value={{ ...onboarding, entered, run, refresh, enterApp: () => setEntered(true) }}
    >
      {children}
    </OnboardingContext.Provider>
  );
}

export function useOnboardingContext(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext);
  if (!ctx) {
    throw new Error("useOnboardingContext must be used inside <OnboardingProvider>");
  }
  return ctx;
}
