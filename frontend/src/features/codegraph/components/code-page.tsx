import { useEffect, useState } from "react";
import { SearchIcon, GitBranchIcon, CheckIcon, AlertCircleIcon, PlusIcon } from "lucide-react";
import { AssetListPanel } from "@/features/assets/components/asset/asset-list-panel";
import { AssetPageHeader } from "@/features/assets/components/asset/asset-page-header";
import { AssetSplitLayout } from "@/features/assets/components/asset/asset-split-layout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AssetShell } from "@/features/assets/components/asset-shell";
import {
  codegraphExplore,
  codegraphInit,
  codegraphIsAvailable,
  codegraphStatus,
  type CodegraphStatusResult,
  errText,
} from "@/lib/api";

function StatusBadge({ status }: { status: CodegraphStatusResult | null }) {
  if (!status) return null;
  if (!status.available) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/10 px-2 py-0.5 text-xs text-amber-600 dark:text-amber-400">
        <AlertCircleIcon className="size-3" /> not available
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-600 dark:text-emerald-400">
      <CheckIcon className="size-3" /> {status.backend} {status.version ? `· ${status.version}` : ""}
    </span>
  );
}

export function CodeAssetPage({
  onBack,
  initialQuery,
  initialResult,
}: {
  onBack: () => void;
  initialQuery?: string;
  initialResult?: string;
}) {
  const [status, setStatus] = useState<CodegraphStatusResult | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<string | null>(null);
  const [exploreLoading, setExploreLoading] = useState(false);
  const [exploreError, setExploreError] = useState<string | null>(null);
  const [isAvailable, setIsAvailable] = useState<boolean | null>(null);
  const [initLoading, setInitLoading] = useState(false);

  useEffect(() => {
    if (initialQuery) setQuery(initialQuery);
    if (initialResult) setResult(initialResult);
  }, [initialQuery, initialResult]);

  useEffect(() => {
    let cancelled = false;
    codegraphIsAvailable()
      .then((v) => !cancelled && setIsAvailable(v))
      .catch(() => !cancelled && setIsAvailable(false));
    codegraphStatus()
      .then((s) => !cancelled && setStatus(s))
      .catch((e) => !cancelled && setStatusError(errText(e)))
      .finally(() => !cancelled && setStatusLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleExplore() {
    const q = query.trim();
    if (!q) return;
    setExploreLoading(true);
    setExploreError(null);
    try {
      const res = await codegraphExplore(q);
      setResult(res.output);
      if (res.isError) setExploreError(res.output.slice(0, 500));
    } catch (e) {
      const msg = errText(e);
      // Feature not enabled → show guidance, not a crash
      if (msg.includes("codegraph feature not enabled")) {
        setExploreError("CodeGraph feature not compiled in this build. Rebuild with --features codegraph.");
      } else {
        setExploreError(msg);
      }
    } finally {
      setExploreLoading(false);
    }
  }

  async function handleInit() {
    setInitLoading(true);
    setStatusError(null);
    try {
      const res = await codegraphInit();
      setStatus(res);
      setStatusError(null);
    } catch (e) {
      const msg = errText(e);
      if (msg.includes("codegraph feature not enabled")) {
        setStatusError("CodeGraph feature not compiled in this build. Rebuild with --features codegraph.");
      } else {
        setStatusError(msg);
      }
    } finally {
      setInitLoading(false);
      // Refresh status after init
      try {
        const s = await codegraphStatus();
        setStatus(s);
      } catch {}
    }
  }

  const sidebarItems = status ? [status] : [];
  const isFeatureOff = statusError?.includes("codegraph feature not enabled") || exploreError?.includes("not compiled");

  return (
    <AssetShell onBack={onBack} subtitle="code graph" title="Code">
      <AssetPageHeader
        actions={
          <div className="flex gap-2">
            <Button disabled={initLoading} onClick={handleInit} size="sm" variant="outline">
              <PlusIcon className="size-3.5" />
              {initLoading ? "Indexing…" : "Register repo"}
            </Button>
            <Button disabled={exploreLoading || !query.trim()} onClick={handleExplore} size="sm">
              <SearchIcon className="size-3.5" />
              Explore
            </Button>
          </div>
        }
        subtitle={
          statusLoading ? "checking…" : status ? status.message.slice(0, 80) : (statusError ?? "code-aware search")
        }
        title="Code Graph"
      />
      <div className="mt-3 space-y-3">
        {/* Query bar — hot-path entry (cached 15m, single-flight) */}
        <div className="flex gap-2">
          <Input
            className="flex-1"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleExplore()}
            placeholder='Try: "create quarterly report" or "mutateElement renderScene"'
            value={query}
          />
        </div>
        {isFeatureOff && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
            CodeGraph not compiled in. Build:{" "}
            <code className="rounded bg-muted px-1">cargo check --features codegraph</code> +{" "}
            <code className="rounded bg-muted px-1">bun tauri dev -- --features codegraph</code>. Or set{" "}
            <code className="rounded bg-muted px-1">CODEGRAPH_BIN</code>.
          </div>
        )}

        <AssetSplitLayout
          detail={
            <div className="rounded-md border bg-card p-3">
              <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
                <span>Result (verbatim source + call paths + blast radius)</span>
                {exploreLoading && <span className="animate-pulse">exploring…</span>}
              </div>
              {exploreError && !result && (
                <div className="rounded bg-destructive/10 px-3 py-2 text-xs text-destructive">{exploreError}</div>
              )}
              {result ? (
                <pre className="max-h-[55dvh] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs leading-relaxed">
                  {result}
                </pre>
              ) : (
                <div className="flex flex-col items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
                  <GitBranchIcon className="size-5 opacity-50" />
                  <span>No explore yet — type a symbol or question above.</span>
                  <span className="text-xs">
                    Tip: agent calls this 1-5× per turn; results are LRU-cached 15 min and single-flight deduped.
                  </span>
                </div>
              )}
            </div>
          }
          sidebar={
            <div className="space-y-3">
              <AssetListPanel
                count={String(sidebarItems.length)}
                emptyText={
                  statusLoading
                    ? "Checking CodeGraph…"
                    : (statusError ?? "No status — is codegraph installed? npm i -g @colbymchenry/codegraph")
                }
                getItemId={(s: CodegraphStatusResult) => s.backend}
                items={sidebarItems}
                onSelect={() => {}}
                renderItem={(s: CodegraphStatusResult) => (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-xs font-medium">
                      <GitBranchIcon className="size-3.5" /> CodeGraph
                      <StatusBadge status={s} />
                    </div>
                    <div className="line-clamp-3 text-xs text-muted-foreground">{s.message}</div>
                    {isAvailable === false && (
                      <div className="text-xs text-amber-600 dark:text-amber-400">
                        Binary not found on PATH — install codegraph CLI or set CODEGRAPH_BIN.
                      </div>
                    )}
                  </div>
                )}
                title="Status"
              />
              <div className="rounded-md border px-3 py-2 text-xs text-muted-foreground">
                <div className="font-medium text-foreground">Hot-path notes</div>
                <ul className="mt-1 list-disc pl-4">
                  <li>Agent `codegraph_explore` is LRU-cached (64, 15m) + single-flight — frequent calls coelesce.</li>
                  <li>Sidecar: `codegraph explore --json` via `CODEGRAPH_BIN` (default `codegraph` on PATH).</li>
                  <li>Treat returned source as already Read.</li>
                </ul>
              </div>
            </div>
          }
          storageKey="kawai:code:splitWidth"
        />
      </div>
    </AssetShell>
  );
}
