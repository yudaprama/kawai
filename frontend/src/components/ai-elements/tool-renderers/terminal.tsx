import type { ReactNode } from "react";
import { cn, isRecord } from "@/lib/utils";
import { Icon } from "@/components/shared/icon";
import { parse, num } from "./shared";

/**
 * cli_run result renderer — presents a command execution the way a terminal
 * would: the command line, a status line (exit code · duration · attempts),
 * then stdout/stderr as terminal output. Replaces the raw field dump
 * (argv / exitCode / durationMs / …) that used to render here.
 */
export function renderCliRun(output: unknown): ReactNode | null {
  const o = parse(output);
  if (!isRecord(o)) return null;

  const command = typeof o.command === "string" ? o.command : null;
  const argv = Array.isArray(o.argv) ? o.argv.filter((a): a is string => typeof a === "string") : null;
  const exitCode = num(o.exitCode);
  const success = o.success === true;
  const stdout = typeof o.stdout === "string" ? o.stdout : "";
  const stderr = typeof o.stderr === "string" ? o.stderr : "";
  const durationMs = num(o.durationMs);
  const attempts = num(o.attempts);
  if (command === null) return null;

  const line = [command, ...(argv ?? [])]
    .map((a) => (a.length > 0 && !/\s/.test(a) ? a : `'${a.replace(/'/g, "'\\''")}'`))
    .join(" ");

  return (
    <div className="not-prose space-y-2">
      <div className="bg-muted/60 overflow-hidden rounded-lg border">
        <div className="flex items-center gap-2 border-b px-3 py-2">
          <Icon name="terminal" className="text-muted-foreground size-3.5 shrink-0" />
          <code className="min-w-0 flex-1 overflow-x-auto text-xs whitespace-pre">{line}</code>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-xs">
          <span
            className={cn(
              "inline-flex items-center gap-1 font-medium",
              success ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"
            )}
          >
            <Icon name={success ? "circle-check" : "circle-x"} className="size-3.5 shrink-0" />
            {success ? "Completed" : `Failed (exit ${exitCode ?? "?"})`}
          </span>
          {durationMs != null && durationMs >= 0 && <span>{durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s`}</span>}
          {attempts != null && attempts > 1 && <span>{attempts} attempts</span>}
        </div>
        {(stdout.trim() || stderr.trim()) && (
          <div className="space-y-1 border-t bg-muted/30 px-3 py-2">
            {stdout.trim() && (
              <pre className="text-muted-foreground max-h-64 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
                {stdout}
              </pre>
            )}
            {stderr.trim() && (
              <pre className="max-h-40 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap text-red-600/80 dark:text-red-400/80">
                {stderr}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
