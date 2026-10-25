import { useEffect, useState } from "react";

import { Icon } from "@/components/shared/icon";
import { call } from "@/lib/api";
import { cn } from "@/lib/utils";

import { Field } from "./workbench-ui";

/** Candle intervals the stop fold accepts (mirrors the backend's
 * `AUDIT_INTERVALS`). Anything else falls back to `4h` server-side. */
const INTERVALS = ["15m", "1h", "4h", "1d", "1w"] as const;

/** Stop-distance presets (mirrors the backend's `AUDIT_RISKS`). */
const RISKS = [
  { id: "tight", label: "Tight", hint: "2× ATR" },
  { id: "standard", label: "Standard", hint: "3× ATR" },
  { id: "wide", label: "Wide", hint: "3.5× ATR" },
] as const;

/** How many positions to grade. "All" passes the backend's max (500) — the
 * audit grades the whole book, largest |notional| first, so the placement
 * offer can list every unprotected position. */
const LIMITS: { value: number; label?: string }[] = [
  { value: 10 },
  { value: 25 },
  { value: 50 },
  { value: 500, label: "All" },
];

/** Market scope (mirrors the backend's `market` param): which futures family
 * the report covers. "All" keeps the combined book; the scoped values grade
 * that ONE family — useful when the two books move on different clocks. */
const MARKETS = [
  { id: "all", label: "All" },
  { id: "usdm", label: "USDⓈ-M" },
  { id: "coinm", label: "COIN-M" },
] as const;

/** Venue whose open book the audit grades. Both exchanges run the SAME fixed
 * pipeline (one audit tool: mirror sync + stop grading + take-profit coverage);
 * they differ in the futures families they have and in whose keys sign. */
export type AuditVenue = "binance" | "mexc";

const VENUES: { id: AuditVenue; label: string }[] = [
  { id: "binance", label: "Binance" },
  { id: "mexc", label: "MEXC" },
];

const VENUE_LABEL: Record<AuditVenue, string> = { binance: "Binance", mexc: "MEXC" };

/** Each venue keeps its OWN pair, so the gate reads the selected venue's
 * status op — a Binance key never authorizes a MEXC audit, and vice versa. */
const CREDENTIAL_OP: Record<AuditVenue, string> = {
  binance: "binance_credentials_status",
  mexc: "mexc_credentials_status",
};

export interface BinanceAuditFormProps {
  disabled?: boolean;
  onSubmit: (interval: string, risk: string, limit: number, market: string, venue: AuditVenue) => void;
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

/** Futures Risk Audit entry form on the Workbench landing. An exchange row,
 * three presets and a button — the pipeline itself is fixed: one audit call
 * (`binance_futures_risk_audit` / `mexc_futures_risk_audit`: mirror sync +
 * stop grading + take-profit coverage) through the supervisor scheduler, then
 * the built-in deliverable writer. No planning round: the audit is already
 * deterministic Rust.
 *
 * READ-ONLY BY DESIGN: this form never places an order. Once the report
 * lands, the run view offers one-click placement of the recommended stops
 * and take-profits (BinanceAuditOffer) — the audit proposes, the user
 * approves there. */
export function BinanceAuditForm({ disabled, onSubmit }: BinanceAuditFormProps) {
  const [venue, setVenue] = useState<AuditVenue>("binance");
  const [interval, setInterval] = useState<string>("4h");
  const [risk, setRisk] = useState<string>("standard");
  // Whole book by default — the placement offer can only list positions this
  // audit graded, so a capped default would quietly limit the approval table.
  const [limit, setLimit] = useState<number>(500);
  const [market, setMarket] = useState<string>("all");
  const [sources, setSources] = useState<Record<AuditVenue, AuditCredentialSource>>({
    binance: null,
    mexc: null,
  });

  useEffect(() => {
    let alive = true;
    for (const v of VENUES.map((x) => x.id)) {
      void call<{ source: "user" | "baked" | "none" }>(CREDENTIAL_OP[v])
        .then((s) => {
          if (alive) setSources((prev) => ({ ...prev, [v]: s.source }));
        })
        .catch(() => {
          // Status unreadable (feature off, op missing) — treat as "not read
          // yet" so the form neither blocks nor claims a source it can't see.
          // The backend gate still fails closed if the run slips through.
          if (alive) setSources((prev) => ({ ...prev, [v]: null }));
        });
    }
    return () => {
      alive = false;
    };
  }, []);

  const source = sources[venue];

  // The audit reports on a PORTFOLIO: naked positions, naked notional, R:R.
  // The built-in pair signs as the product's account, so an audit run on it
  // grades someone else's exposure and hands the verdict to the user under
  // their own name — numbers that look actionable and are not. Only the
  // user's own keys make the report about them, so `baked` blocks exactly
  // like `none` (with a different reason).
  const missingOwnKeys = !ownsAuditScope(source);
  const submit = () => {
    if (disabled || missingOwnKeys) return;
    onSubmit(interval, risk, limit, market, venue);
  };
  const chip = (active: boolean) =>
    cn(
      "rounded-md border px-2.5 py-1 font-mono text-[0.6875rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
      active
        ? "border-primary/60 bg-primary/10 text-primary"
        : "border-border text-muted-foreground hover:border-[var(--tea-color-border-focus)] hover:text-foreground",
    );

  return (
    <div className="border-border/60 w-full rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="shield-check" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">Futures Risk Audit</span>
        <span className="text-muted-foreground font-mono text-[0.625rem]">fixed pipeline · no planning round</span>
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Field label="Exchange">
          {VENUES.map((v) => (
            <button
              key={v.id}
              type="button"
              disabled={disabled}
              aria-pressed={venue === v.id}
              onClick={() => setVenue(v.id)}
              title={`Grade the ${v.label} futures book`}
              className={chip(venue === v.id)}
            >
              {v.label}
            </button>
          ))}
        </Field>

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
          {LIMITS.map((l) => (
            <button
              key={l.value}
              type="button"
              disabled={disabled}
              aria-pressed={limit === l.value}
              onClick={() => setLimit(l.value)}
              title={l.label === "All" ? "Grade the whole book" : undefined}
              className={chip(limit === l.value)}
            >
              {l.label ?? l.value}
            </button>
          ))}
        </Field>

        {/* The market scope is Binance's futures-FAMILY selector; MEXC has one
            USDT-margined family, so the row would be a choice with one answer. */}
        {venue === "binance" && (
          <Field label="Market">
            {MARKETS.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={disabled}
                aria-pressed={market === m.id}
                onClick={() => setMarket(m.id)}
                title={m.id === "all" ? "Grade both futures markets" : `Grade the ${m.label} book only`}
                className={chip(market === m.id)}
              >
                {m.label}
              </button>
            ))}
          </Field>
        )}
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
        {source === "user" && <span className="text-muted-foreground font-mono text-[0.625rem]">using your keys</span>}
      </div>

      {source === "baked" && (
        <p className="text-destructive mt-3 font-mono text-[0.625rem] leading-relaxed" role="alert">
          The audit grades YOUR open positions, so it needs your own {VENUE_LABEL[venue]} keys. Add one (IP-restricted)
          in Settings → Credentials.
        </p>
      )}
      {source === "none" && (
        <p className="text-destructive mt-3 font-mono text-[0.625rem] leading-relaxed" role="alert">
          No {VENUE_LABEL[venue]} API keys yet. Add a read-only, IP-restricted pair in Settings → Credentials — the
          audit reads your open positions and resting orders, and never places an order.
        </p>
      )}
      <p className="text-muted-foreground mt-3 font-mono text-[0.625rem] leading-relaxed">
        Read-only: syncs your positions and resting orders, grades every stop, checks TP coverage, writes the report.
        The audit itself never places, modifies, or cancels an order —{" "}
        {venue === "mexc"
          ? "MEXC placement is not wired yet, so the recommended stops and take-profits are yours to place on the exchange."
          : "after the report lands, the run view offers one-click placement of the recommended stops and take-profits, and nothing is sent until you approve it there."}
      </p>
    </div>
  );
}
