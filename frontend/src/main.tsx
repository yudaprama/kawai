import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { SentryErrorBoundary } from "@/components/error-boundary";
import { AuthGate } from "@/features/auth/auth-gate";
import { ContextGatheringStep } from "@/features/auth/context-gathering-step";
import { OnboardingProvider } from "@/features/auth/onboarding-provider";
import { getLocale } from "@/lib/i18n";
import { installViewportResync } from "@/lib/viewport-resync";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./app/App";
import "./index.css";

// Reflect the resolved locale (stored override → navigator → en) on <html>
// so lang-dependent CSS/fonts/assistive tech behave correctly from first paint.
document.documentElement.lang = getLocale();

// Sentry is opt-in: init only when VITE_SENTRY_DSN is set (build-time env,
// e.g. in .env.local or the release CI). Without a DSN the SDK stays inert —
// logger.ts calls become no-ops and the boundary still renders its fallback.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;

if (sentryDsn) {
  Sentry.init({
    dsn: sentryDsn,
    dataCollection: {
      // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
      // https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/#dataCollection
      // userInfo: false,
      // httpBodies: []
    },
    beforeSend(event) {
      const msg = event.exception?.values?.[0]?.value ?? (event.message as string | undefined) ?? "";
      // Filter expected transient noise — these are caught & retried in use-supervisor-chat.ts
      // and would flood Sentry if ever surfaced as unhandled.
      if (msg.toLowerCase().includes("not authenticated") || msg.toLowerCase().includes("no model loaded")) {
        return null;
      }
      // Make Sentry → console 1:1 so every Sentry event is also visible in DevTools/WKWebView console.
      if (import.meta.env.DEV) {
        console.error("[Sentry] captured:", event);
      }
      return event;
    },
  });
}

// The shell is sized by CSS viewport metrics (`h-dvh` + `env(safe-area-inset-*)`)
// with no scroll fallback (`html { overflow: clip }`), so a viewport left stale
// by a background→foreground switch sticks until something else resizes the
// window. Installed before React mounts so the Android resume poke
// (MainActivity.onResume) always finds the entry point — see lib/viewport-resync.ts.
installViewportResync();

const rootEl = document.getElementById("root");
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <SentryErrorBoundary>
        <TooltipProvider>
          <AuthGate>
            <OnboardingProvider>
              <ContextGatheringStep>
                <App />
              </ContextGatheringStep>
            </OnboardingProvider>
          </AuthGate>
          <Toaster />
        </TooltipProvider>
      </SentryErrorBoundary>
    </React.StrictMode>,
  );
}

// Pre-warm the markdown pipeline at idle: it is externalized to esm.sh (see
// the GUARD in index.html) and otherwise cold-fetches over the network on the
// FIRST deliverable render — mid-read, worst on a mobile radio. Dynamic
// import of the seam (never a static import — the entry chunk must stay
// CDN-free) warms the exact module graph the first render resolves. mermaid
// stays cold: rare and by far the heaviest.
const warmMarkdownPipeline = () => {
  void import("@/lib/streamdown").catch(() => {});
};
if (typeof window.requestIdleCallback === "function") {
  window.requestIdleCallback(warmMarkdownPipeline, { timeout: 8000 });
} else {
  window.setTimeout(warmMarkdownPipeline, 1500);
}
