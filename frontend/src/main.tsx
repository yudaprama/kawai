import * as Sentry from "@sentry/react";
import React from "react";
import ReactDOM from "react-dom/client";
import { SentryErrorBoundary } from "@/components/error-boundary";
import { AuthGate } from "@/components/auth-gate";
import { ClerkProvider } from "@clerk/react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import App from "./App";
import "./index.css";

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

const rootEl = document.getElementById("root");
if (rootEl) {
  ReactDOM.createRoot(rootEl).render(
    <React.StrictMode>
      <SentryErrorBoundary>
        <TooltipProvider>
          <ClerkProvider publishableKey={import.meta.env.VITE_CLERK_PUBLISHABLE_KEY}>
            <AuthGate>
              <App />
            </AuthGate>
          </ClerkProvider>
          <Toaster />
        </TooltipProvider>
      </SentryErrorBoundary>
    </React.StrictMode>,
  );
}
