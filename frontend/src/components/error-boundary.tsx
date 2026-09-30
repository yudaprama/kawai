import { ErrorBoundary as SentryReactErrorBoundary } from "@sentry/react";
import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import { call } from "@/lib/api";

export function ErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("errors.generic")}</h2>
        <p className="text-muted-foreground max-w-md text-sm">{error?.message || t("errors.unexpected")}</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={onRetry} variant="outline">
          {t("common.retry")}
        </Button>
        <Button onClick={() => window.location.reload()}>{t("errors.reloadApp")}</Button>
      </div>
    </div>
  );
}

function SentryFallback({ error, resetError }: { error: unknown; resetError: () => void }) {
  useEffect(() => {
    console.error("Uncaught render error:", error);
    // Mirror to platform log — Sentry already captured the exception.
    call("frontend_log", { level: "error", message: String(error) }).catch(() => {});
  }, [error]);

  return <ErrorFallback error={error as Error} onRetry={resetError} />;
}

/** Sentry-native boundary — automatically calls `Sentry.captureException` +
 *  renders the fallback UI. Also mirrors to `frontend_log` so shipped builds
 *  stay diagnosable without devtools. */
export function SentryErrorBoundary({ children }: { children: ReactNode }) {
  return (
    <SentryReactErrorBoundary
      fallback={({ error, resetError }) => <SentryFallback error={error} resetError={resetError} />}
      beforeCapture={(scope) => {
        scope.setTag("boundary", "root");
      }}
    >
      {children}
    </SentryReactErrorBoundary>
  );
}
