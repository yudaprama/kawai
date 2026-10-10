import { useEffect, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { call } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Candle intervals the stop fold accepts (mirrors the backend's
 * `AUDIT_INTERVALS`). Anything else falls back to `4h` server-side. */
const INTERVALS = ["15m", "1h", "4h", "1d", "1w"] as const;

/** Stop-distance presets (mirrors the backend's `AUDIT_RISKS`). */
const RISKS = [
  { id: "tight", label: "Tight", hint: "2× ATR" },
  { id: "standard", label: "Standard", hint: "3× ATR" },
  { id: "wide", label: "Wide", hint: "3.5× ATR" },
] as const;

/** How many positions to grade. The audit caps at 50 and takes the largest
 * |notional| first, so a lower number trades detail for a shorter run. */
const LIMITS = [10, 25, 50] as const;

export interface BinanceAuditFormProps {
  disabled?: boolean;
  onSubmit: (interval: string, risk: string, limit: number) => void;
}

/** Which credential source the audit is allowed to run under. `null` is the
 * pre-read state — the form has not asked yet, so it must not block. */
export type AuditCredentialSource = "user" | "baked" | "none" | null;

/** The audit reports on a PORTFOLIO — naked positions, naked notional, R:R —
 * so it may only run when the signed calls are the USER's own. The built-in
 * pair (`baked`) signs as the product account: an audit on it grades someone
 * else's exposure and hands the verdict to this user under their own name.
 * `none` has no pair at all. Both block; the UI explains each differently.
 *
 * The backend re-checks the same condition and fails closed before any plan
 * is built (both wrappers) — this predicate is the UX half, not the gate. */
export function ownsAuditScope(source: AuditCredentialSource): boolean {
  return source === null || source === "user";
}

/** Futures Risk Audit entry form on the Workbench landing. Three presets and
 * a button — the pipeline itself is fixed: one `binance_futures_risk_audit`
 * call (mirror sync + stop grading + take-profit coverage) through the
 * supervisor scheduler, then the built-in deliverable writer. No planning
 * round: the audit is already deterministic Rust.
 *
 * The form reads the credential source so a user without keys — or relying on
 * the product's built-in pair — learns it HERE, next to the button that would
 * otherwise produce a portfolio report that isn't about them. */
export function BinanceAuditForm({ disabled, onSubmit }: BinanceAuditFormProps) {
  const [interval, setInterval] = useState<string>("4h");
  const [risk, setRisk] = useState<string>("standard");
  const [limit, setLimit] = useState<number>(25);
  const [source, setSource] = useState<AuditCredentialSource>(null);

  useEffect(() => {
    let alive = true;
    void call<{ source: "user" | "baked" | "none" }>("binance_credentials_status")
      .then((s) => {
        if (alive) setSource(s.source);
      })
      .catch(() => {
        // Status unreadable (feature off, op missing) — treat as "not read
        // yet" so the form neither blocks nor claims a source it can't see.
        // The backend gate still fails closed if the run slips through.
        if (alive) setSource(null);
      });
    return () => {
      alive = false;
    };
  }, []);

  // The audit reports on a PORTFOLIO: naked positions, naked notional, R:R.
  // The built-in pair signs as the product's account, so an audit run on it
  // grades someone else's exposure and hands the verdict to the user under
  // their own name — numbers that look actionable and are not. Only the
  // user's own keys make the report about them, so `baked` blocks exactly
  // like `none` (with a different reason).
  const missingOwnKeys = !ownsAuditScope(source);
  const submit = () => {
    if (disabled || missingOwnKeys) return;
    onSubmit(interval, risk, limit);
  };
  const chip = (active: boolean) =>
    cn(
      "rounded-md border px-2.5 py-1 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      active
        ? "border-primary/60 bg-primary/10 text-primary"
        : "border-border text-muted-foreground hover:border-[var(--tea-color-border-focus)] hover:text-foreground",
    );

  return (
    <div className="border-border/60 w-full rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="shield-check" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">Futures Risk Audit</span>
        <span className="text-muted-foreground font-mono text-[10px]">fixed pipeline · no planning round</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Field label="Candles">
          {INTERVALS.map((iv) => (
            <button
              key={iv}
              type="button"
              disabled={disabled}
              aria-pressed={interval === iv}
              onClick={() => setInterval(iv)}
              className={chip(interval === iv)}
            >
              {iv}
            </button>
          ))}
        </Field>

        <Field label="Stop distance">
          {RISKS.map((r) => (
            <button
              key={r.id}
              type="button"
              disabled={disabled}
              aria-pressed={risk === r.id}
              onClick={() => setRisk(r.id)}
              title={`${r.label} — ${r.hint}`}
              className={chip(risk === r.id)}
            >
              {r.label}
            </button>
          ))}
        </Field>

        <Field label="Positions graded">
          {LIMITS.map((n) => (
            <button
              key={n}
              type="button"
              disabled={disabled}
              aria-pressed={limit === n}
              onClick={() => setLimit(n)}
              className={chip(limit === n)}
            >
              {n}
            </button>
          ))}
        </Field>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={disabled || missingOwnKeys}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-mono text-xs font-bold tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="zap" className="size-3.5" />
          Audit portfolio
        </button>
        {source === "user" && <span className="text-muted-foreground font-mono text-[10px]">using your keys</span>}
      </div>

      {source === "baked" && (
        <p className="text-destructive mt-3 font-mono text-[10px] leading-relaxed" role="alert">
          The audit grades YOUR open positions, so it needs your own Binance keys. Add one (IP-restricted) in
          Settings → Credentials.
        </p>
      )}
      {source === "none" && (
        <p className="text-destructive mt-3 font-mono text-[10px] leading-relaxed" role="alert">
          No Binance API keys yet. Add a read-only, IP-restricted pair in Settings → Credentials — the audit reads your
          open positions and resting orders, and never places an order.
        </p>
      )}
      <p className="text-muted-foreground mt-3 font-mono text-[10px] leading-relaxed">
        Read-only: syncs your positions and resting orders, grades every stop, checks TP coverage, writes the report.
        Never touches your orders — placing one is a separate opt-in that asks you first.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}
