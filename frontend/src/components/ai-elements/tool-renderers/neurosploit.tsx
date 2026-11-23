//! NeuroSploit deep-audit renderer: the `neurosploit_audit` envelope from the
//! in-process harness agent tool. One flat, kind-tagged JSON envelope —
//! progress phase is a separate export (`renderNeurosploitProgress`) because
//! the streaming op forwards plain text lines, not a partial envelope.
//! Foreign payloads are refused (null), never half-rendered.

import type { ReactNode } from "react";

import { Icon } from "@/components/shared/icon";

import { cn } from "@/lib/utils";
import { parse, isRecord, num, str, Footnote, MetricGrid, TextCard, type Metric } from "./shared";
import { ClampedSection } from "./security";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

const SEVERITY_CLASS: Record<Severity, string> = {
  CRITICAL: "text-destructive",
  HIGH: "text-destructive",
  MEDIUM: "text-warning",
  LOW: "text-muted-foreground",
  INFO: "text-muted-foreground",
};

const SEVERITY_ACCENT: Record<Severity, string> = {
  CRITICAL: "border-l-destructive",
  HIGH: "border-l-destructive",
  MEDIUM: "border-l-warning",
  LOW: "border-l-border",
  INFO: "border-l-border",
};

const MAX_FINDINGS = 25;

/** One harness finding — the Rust tool's camelCase projection of the
 *  NeuroSploit `Finding` (envelope contract in PLAN-neurosploit.md §6). */
interface Finding {
  title: string;
  severity: Severity;
  confidence: string;
  cwe: string;
  cvss: string;
  url: string;
  evidence: string;
  impact: string;
  remediation: string;
  validated: boolean;
}

function severityOf(raw: unknown): Severity {
  const s = str(raw)?.toUpperCase() ?? "";
  return (SEVERITY_ORDER as string[]).includes(s) ? (s as Severity) : "INFO";
}

function readFinding(v: unknown): Finding | null {
  if (!isRecord(v) || typeof v.title !== "string") return null;
  return {
    title: v.title,
    severity: severityOf(v.severity),
    confidence: str(v.confidence) ?? "—",
    cwe: str(v.cwe) ?? "",
    cvss: str(v.cvss) ?? "",
    url: str(v.url) ?? "",
    evidence: str(v.evidence) ?? "",
    impact: str(v.impact) ?? "",
    remediation: str(v.remediation) ?? "",
    validated: v.validated === true,
  };
}

/** One finding: severity accent border, labeled slots, bounded text with
 *  in-place expand — the security.tsx card contract, plus the harness's
 *  `validated` confirmation mark. */
function FindingCard({ finding: f }: { finding: Finding }) {
  const meta = [
    f.cvss ? `CVSS ${f.cvss}` : null,
    f.confidence !== "—" ? `conf ${f.confidence}` : null,
    f.cwe || null,
    f.validated ? "validated" : null,
  ]
    .filter((v): v is string => v !== null)
    .join(" · ");

  return (
    <div
      className={cn(
        "space-y-1 rounded-md border border-l-2 bg-muted/30 p-2",
        SEVERITY_ACCENT[f.severity],
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-2">
        <span
          className={cn("font-mono text-[11px] font-semibold", SEVERITY_CLASS[f.severity])}
        >
          {f.severity}
        </span>
        {meta && <span className="text-muted-foreground text-[11px] tabular-nums">{meta}</span>}
      </div>
      <div className="font-medium text-sm text-foreground">
        {f.title}
        {f.validated && (
          <Icon
            name="circle-check"
            className="text-emerald-600 ml-1.5 inline size-3.5 align-[-2px] dark:text-emerald-400"
          />
        )}
      </div>
      {f.url && (
        <div className="text-muted-foreground truncate text-xs" title={f.url}>
          {f.url}
        </div>
      )}
      {f.impact && (
        <ClampedSection label="impact" text={f.impact} clampClass="line-clamp-3" />
      )}
      {f.evidence && (
        <ClampedSection label="evidence" text={f.evidence} clampClass="line-clamp-3" mono />
      )}
      {f.remediation && (
        <ClampedSection label="remediation" text={f.remediation} clampClass="line-clamp-3" />
      )}
    </div>
  );
}

/** Timed-out state: the run hit kawai's wall-clock backstop but its state is
 *  persisted — a resume is a re-submit with `resume: true` (no new backend
 *  call from here; the harness op handles it). */
function TimedOutBanner({ workdir, resumable }: { workdir: string; resumable: boolean }) {
  return (
    <div className="rounded-md border border-l-2 border-l-warning bg-muted/30 space-y-1 p-2">
      <div className="text-warning flex items-center gap-1.5 text-xs font-medium">
        <Icon name="clock" className="size-3.5 shrink-0" />
        Timed out{resumable ? " — resumable" : ""}
      </div>
      {workdir && (
        <div className="text-muted-foreground truncate font-mono text-[11px]" title={workdir}>
          {workdir}
        </div>
      )}
      {resumable && (
        <Footnote>
          Partial state is saved in the run directory — submit the audit again with
          <code className="bg-muted mx-1 rounded px-1 font-mono">resume: true</code>
          to continue where it stopped.
        </Footnote>
      )}
    </div>
  );
}

export function renderNeurosploitAudit(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || d.kind !== "neurosploit_audit") return null;
  if (typeof d.target !== "string") return null;
  if (!Array.isArray(d.findings)) return null;
  const findings = d.findings.map(readFinding).filter((f): f is Finding => f !== null);

  const summary = isRecord(d.summary) ? d.summary : {};
  const confirmed = num(summary.confirmed) ?? 0;
  const needsReview = num(summary.needsReview) ?? 0;
  const total = num(summary.total) ?? findings.length;
  const usage = isRecord(d.usage) ? d.usage : {};
  const calls = num(usage.calls);
  const tokens =
    num(usage.inputTokens) != null && num(usage.outputTokens) != null
      ? (num(usage.inputTokens) ?? 0) + (num(usage.outputTokens) ?? 0)
      : null;
  const durationMs = num(d.durationMs);
  const timedOut = d.timedOut === true;
  const resumable = d.resumable === true;
  const truncated = d.truncated === true;
  const workdir = str(d.workdir) ?? "";

  const metrics: Metric[] = [
    {
      label: "Deep audit",
      value: `${total} finding${total === 1 ? "" : "s"}`,
      sub: `${confirmed} confirmed · ${needsReview} need review`,
      tone: confirmed > 0 ? "danger" : total > 0 ? "warn" : "ok",
    },
    ...(durationMs != null
      ? [{ label: "Duration", value: durationMs < 1000 ? `${durationMs} ms` : `${(durationMs / 1000).toFixed(1)} s` }]
      : []),
    ...(calls != null ? [{ label: "LLM calls", value: String(calls) }] : []),
    ...(tokens != null ? [{ label: "Tokens", value: tokens.toLocaleString() }] : []),
  ];

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  return (
    <TextCard>
      <div className="text-muted-foreground truncate text-xs" title={d.target}>
        {d.target}
      </div>
      <MetricGrid items={metrics} />
      {(timedOut || resumable) && <TimedOutBanner workdir={workdir} resumable={resumable} />}
      {sorted.length === 0 && !timedOut ? (
        <Footnote>No findings — what was tested is recorded above.</Footnote>
      ) : sorted.length > 0 ? (
        <div className="space-y-2">
          {sorted.slice(0, MAX_FINDINGS).map((f, i) => (
            <FindingCard key={i} finding={f} />
          ))}
          {(sorted.length > MAX_FINDINGS || truncated) && (
            <Footnote>
              {sorted.length > MAX_FINDINGS
                ? `${sorted.length - MAX_FINDINGS} more findings${truncated ? " (truncated)" : ""} — ask for the full list.`
                : "Result list truncated by the harness — ask for the full findings."}
            </Footnote>
          )}
        </div>
      ) : null}
    </TextCard>
  );
}

/**
 * Streaming phase: the harness op forwards plain text progress lines
 * (`notify: …`, `▶/✓/✗/⚠ …`, `@<agent> ai: …`) — render them in the
 * terminal-card style the cli_run renderer uses.
 */
export function renderNeurosploitProgress(lines: string[]): ReactNode {
  if (lines.length === 0) return null;
  return (
    <div className="bg-muted/60 overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Icon name="terminal" className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-muted-foreground text-xs font-medium">Deep audit — progress</span>
      </div>
      <div className="bg-muted/30 px-3 py-2">
        <pre className="text-muted-foreground max-h-64 overflow-auto font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {lines.join("\n")}
        </pre>
      </div>
    </div>
  );
}
