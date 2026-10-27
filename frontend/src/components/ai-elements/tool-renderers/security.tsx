//! Security renderers: the lonkero engine's flat, kind-tagged scan envelopes.
//!
//! `security_scan` / `security_recon` / `security_subdomains` share one
//! findings card (severity-sorted); `security_modules` renders the category
//! catalog. Foreign payloads are refused (null), never half-rendered.

import { type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { parse, isRecord, num, str, Footnote, MetricGrid, TextCard, type CardItem, cards, type Metric } from "./shared";

type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

const SEVERITY_CLASS: Record<Severity, string> = {
  CRITICAL: "text-destructive",
  HIGH: "text-destructive",
  MEDIUM: "text-warning",
  LOW: "text-muted-foreground",
  INFO: "text-muted-foreground",
};

const FINDING_KINDS: Record<string, true> = {
  security_scan: true,
  security_recon: true,
  security_subdomains: true,
};

const MAX_FINDINGS = 8;

/** One lonkero finding, projected camelCase by the Rust tool. */
interface Finding {
  vulnType: string;
  severity: Severity;
  confidence: string;
  url: string;
  parameter: string | null;
  evidence: string | null;
  remediation: string;
  cwe: string;
  cvss: number;
}

function severityOf(raw: unknown): Severity {
  const s = str(raw)?.toUpperCase() ?? "";
  return (SEVERITY_ORDER as string[]).includes(s) ? (s as Severity) : "INFO";
}

function readFinding(v: unknown): Finding | null {
  if (!isRecord(v) || typeof v.vulnType !== "string") return null;
  return {
    vulnType: v.vulnType,
    severity: severityOf(v.severity),
    confidence: str(v.confidence) ?? "—",
    url: str(v.url) ?? "",
    parameter: str(v.parameter) ?? null,
    evidence: str(v.evidence) ?? null,
    remediation: str(v.remediation) ?? "",
    cwe: str(v.cwe) ?? "",
    cvss: num(v.cvss) ?? 0,
  };
}

function SecurityFindingsView({
  kind,
  target,
  findings,
  testsRun,
  durationSeconds,
  earlyTerminated,
  terminationReason,
}: {
  kind: string;
  target: string;
  findings: Finding[];
  testsRun: number;
  durationSeconds: number;
  earlyTerminated: boolean;
  terminationReason: string | null;
}) {
  const counts = SEVERITY_ORDER.map((sev) => ({
    sev,
    n: findings.filter((f) => f.severity === sev).length,
  })).filter((c) => c.n > 0);

  const summary: Metric[] = [
    {
      label: kind === "security_recon" ? "Recon" : kind === "security_subdomains" ? "Subdomains" : "Scan",
      value: `${findings.length} finding${findings.length === 1 ? "" : "s"}`,
      sub: counts.map((c) => `${c.sev.toLowerCase()} ${c.n}`).join(" · ") || "clean",
      tone: findings.some((f) => f.severity === "CRITICAL" || f.severity === "HIGH")
        ? "danger"
        : findings.length
          ? "warn"
          : "ok",
    },
    { label: "Tests run", value: String(testsRun) },
    { label: "Duration", value: `${durationSeconds.toFixed(1)}s` },
  ];

  const sorted = [...findings].sort(
    (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
  );

  return (
    <TextCard>
      <div className="text-muted-foreground truncate text-xs" title={target}>
        {target}
      </div>
      <MetricGrid items={summary} />
      {earlyTerminated && terminationReason && (
        <Footnote>Stopped early: {terminationReason}</Footnote>
      )}
      {sorted.length === 0 ? (
        <Footnote>No findings — what was tested is recorded above.</Footnote>
      ) : (
        <div className="space-y-2">
          {sorted.slice(0, MAX_FINDINGS).map((f, i) => (
            <div key={i} className="space-y-1 rounded-md border bg-muted/30 p-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className={cn("font-mono text-[11px] font-semibold", SEVERITY_CLASS[f.severity])}>
                  {f.severity}
                </span>
                <span className="text-muted-foreground text-[11px] tabular-nums">
                  {f.cvss > 0 ? `CVSS ${f.cvss.toFixed(1)} · ` : ""}
                  {f.confidence}
                  {f.cwe ? ` · ${f.cwe}` : ""}
                </span>
              </div>
              <div className="font-medium text-sm text-foreground">{f.vulnType}</div>
              {f.url && <div className="text-muted-foreground truncate text-xs">{f.url}</div>}
              {f.parameter && (
                <div className="text-muted-foreground text-xs">
                  parameter <code className="bg-muted rounded px-1">{f.parameter}</code>
                </div>
              )}
              {f.evidence && (
                <div className="text-muted-foreground line-clamp-3 font-mono text-[11px] break-all">
                  {f.evidence}
                </div>
              )}
              {f.remediation && <Footnote>{f.remediation}</Footnote>}
            </div>
          ))}
          {sorted.length > MAX_FINDINGS && (
            <Footnote>
              {sorted.length - MAX_FINDINGS} more findings — ask for the full list.
            </Footnote>
          )}
        </div>
      )}
    </TextCard>
  );
}

/** Shared card for the three finding-producing security tools. */
export function renderSecurityScan(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || typeof d.kind !== "string" || !FINDING_KINDS[d.kind]) return null;
  if (typeof d.target !== "string") return null;
  if (!Array.isArray(d.findings)) return null;
  const findings = d.findings.map(readFinding).filter((f): f is Finding => f !== null);
  return (
    <SecurityFindingsView
      kind={d.kind}
      target={d.target}
      findings={findings}
      testsRun={num(d.testsRun) ?? 0}
      durationSeconds={num(d.durationSeconds) ?? 0}
      earlyTerminated={Boolean(d.earlyTerminated)}
      terminationReason={str(d.terminationReason) ?? null}
    />
  );
}

/** The category catalog: id, description, module count per group. */
export function renderSecurityModules(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || d.kind !== "security_modules" || !Array.isArray(d.categories)) return null;
  const items: CardItem[] = d.categories
    .filter(isRecord)
    .filter((c) => typeof c.id === "string")
    .map((c) => ({
      title: String(c.id) + (c.forceMaximumIntensity ? " (always maximum)" : ""),
      subtitle: typeof c.description === "string" ? c.description : undefined,
      meta: Array.isArray(c.modules) ? `${c.modules.length} modules` : undefined,
    }));
  return items.length ? cards(items) : null;
}
