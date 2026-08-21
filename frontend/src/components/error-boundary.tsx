import { Component, type ReactNode, useEffect } from "react";
import * as Sentry from "@sentry/react";
import { ErrorBoundary as SentryReactErrorBoundary } from "@sentry/react";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/api";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export function ErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">Something went wrong</h2>
        <p className="text-muted-foreground max-w-md text-sm">
          {error?.message || "An unexpected error occurred."}
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={onRetry} variant="outline">
          Try again
        </Button>
        <Button onClick={() => window.location.reload()}>Reload app</Button>
      </div>
    </div>
  );
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Use logger semantics: console + Sentry + frontend_log are handled here directly
    // to avoid double-capture via logError's own Sentry call + boundary auto-capture.
    console.error("Uncaught render error:", error);
    Sentry.captureException(error, { tags: { boundary: "legacy" } });
    call("frontend_log", { level: "error", message: String(error) }).catch(() => {});
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorFallback
          error={this.state.error}
          onRetry={() => this.setState({ error: null })}
        />
      );
    }
    return this.props.children;
  }
}

function SentryFallback({
  error,
  resetError,
}: {
  error: unknown;
  resetError: () => void;
}) {
  useEffect(() => {
    console.error("Uncaught render error:", error);
    // Mirror to platform log — Sentry already captured the exception.
    call("frontend_log", { level: "error", message: String(error) }).catch(() => {});
  }, [error]);

  return <ErrorFallback error={error as Error} onRetry={resetError} />;
}

/** Sentry-native boundary — prefer this in new code. Automatically calls
 *  `Sentry.captureException` + renders the same fallback. Also mirrors to
 *  `frontend_log` so shipped builds stay diagnosable without devtools. */
export function SentryErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <SentryReactErrorBoundary
      fallback={({ error, resetError }) => (
        <SentryFallback error={error} resetError={resetError} />
      )}
      beforeCapture={(scope) => {
        scope.setTag("boundary", "root");
      }}
    >
      {children}
    </SentryReactErrorBoundary>
  );
}
