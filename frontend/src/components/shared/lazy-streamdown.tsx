import { Component, Suspense, lazy, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { getLocale, translate } from "@/lib/i18n";
import type { StreamdownProps } from "@/lib/streamdown";

// The markdown pipeline (unified/remark/shiki/mermaid/katex) is externalized
// to esm.sh at build time (vite.config.ts rollupOptions.external) and resolves
// through the importmap in index.html AT RUNTIME. These modules must never
// enter the entry chunk: a CDN failure during boot would otherwise fail the
// whole static module graph before React mounts — a permanent empty window
// that no error boundary can catch (the boundary lives inside React). Every
// markdown surface renders through this seam: the CDN modules load behind a
// dynamic import, with a retryable fallback on failure.
const Streamdown = lazy(() => import("@/lib/streamdown").then((m) => ({ default: m.Streamdown })));

export type LazyStreamdownProps = StreamdownProps;

class StreamdownBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

function RetryCard({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="text-muted-foreground flex flex-col items-center gap-2 p-4 text-center text-xs" role="alert">
      <span>{translate(getLocale(), "markdown.renderFailed")}</span>
      <Button onClick={onRetry} size="sm" variant="outline">
        {translate(getLocale(), "common.retry")}
      </Button>
    </div>
  );
}

/** Lazy markdown renderer. Renders nothing while the pipeline loads (the
 *  retry card on failure); the `key` remount re-runs the dynamic import — a
 *  failed module fetch is not cached, so retry re-requests the CDN. */
export function LazyStreamdown(props: LazyStreamdownProps) {
  const [attempt, setAttempt] = useState(0);
  return (
    <StreamdownBoundary fallback={<RetryCard onRetry={() => setAttempt((n) => n + 1)} />} key={attempt}>
      <Suspense fallback={null}>
        <Streamdown {...props} />
      </Suspense>
    </StreamdownBoundary>
  );
}
