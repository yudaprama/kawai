import React from "react";
import ReactDOM from "react-dom/client";
import * as Sentry from "@sentry/react";
import App from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SentryErrorBoundary } from "@/components/error-boundary";
import "./index.css";

Sentry.init({
  dsn: "https://623c336d2a998f56cbc14e7a9d3b8fc4@o4510620614983680.ingest.us.sentry.io/4511949267992576",
  dataCollection: {
    // To disable sending user data and HTTP bodies, uncomment the lines below. For more info visit:
    // https://docs.sentry.io/platforms/javascript/guides/react/configuration/options/#dataCollection
    // userInfo: false,
    // httpBodies: []
  },
  beforeSend(event) {
    const msg =
      event.exception?.values?.[0]?.value ??
      (event.message as string | undefined) ??
      "";
    // Filter expected transient noise — these are caught & retried in use-local-chat.ts
    // and would flood Sentry if ever surfaced as unhandled.
    if (msg.toLowerCase().includes("not authenticated") || msg.toLowerCase().includes("no model loaded")) {
      return null;
    }
    // Make Sentry → console 1:1 so every Sentry event is also visible in DevTools/WKWebView console.
    // This fixes "terkirim ke Sentry tapi tidak terprint ke console".
    if (import.meta.env.DEV) {
      console.error("[Sentry] captured:", event);
    }
    return event;
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <SentryErrorBoundary>
      <TooltipProvider>
        <App />
        <Toaster />
      </TooltipProvider>
    </SentryErrorBoundary>
  </React.StrictMode>,
);
