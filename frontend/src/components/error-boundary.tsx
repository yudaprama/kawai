import { ErrorBoundary as SentryReactErrorBoundary } from "@sentry/react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/hooks/use-i18n";
import { call } from "@/lib/api";

export function ErrorFallback({ error, onRetry }: { error: Error | null; onRetry: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const message = error?.message || t("errors.unexpected");
  /** Message + stack for a bug report — the fallback is often the only
   *  surface a shipped build offers (no devtools in a packaged app). */
  const copyDetails = () => {
    const details = `kawai render error\n${message}\n\n${error?.stack ?? "(no stack)"}`;
    void navigator.clipboard
      .writeText(details)
      .then(() => setCopied(true))
      .catch(() => {});
  };
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t("errors.generic")}</h2>
        <p className="text-muted-foreground max-w-md text-sm" role="alert">
          {message}
        </p>
      </div>
      <div className="flex gap-2">
        <Button onClick={onRetry} variant="outline">
          {t("common.retry")}
        </Button>
        <Button onClick={() => window.location.reload()}>{t("errors.reloadApp")}</Button>
        <Button
          aria-label={t("errors.copyDetails")}
          onClick={copyDetails}
          title={t("errors.copyDetails")}
          variant="outline"
        >
          {copied ? t("common.copied") : t("errors.copyDetails")}
        </Button>
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
