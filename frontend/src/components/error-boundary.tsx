import { Component, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { call } from "@/lib/api";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

function ErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
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
    console.error("Uncaught render error:", error);
    // Mirror into the platform log file so crashes are diagnosable from a
    // shipped build (no devtools there). Best-effort — `frontend_log` is a
    // fire-and-forget command.
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
