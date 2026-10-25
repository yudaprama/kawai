import { useState } from "react";

import { PeriodSubmitCard } from "./workbench-ui";

/** Venue the review reads. `undefined` = every exchange — the field is
 *  OPTIONAL on the backend and omitting it syncs all venues' fills. */
export type TradingVenue = "binance" | "mexc";

export interface TradingPerformanceFormProps {
  disabled?: boolean;
  onSubmit: (period: string, venue?: TradingVenue) => void;
}

/** Same pill idiom as the period presets below, so the venue row reads as
 *  part of the form rather than a widget dropped into it. */
const VENUES: { label: string; value?: TradingVenue }[] = [
  { label: "Semua exchange" },
  { label: "Binance", value: "binance" },
  { label: "MEXC", value: "mexc" },
];

/** "YYYY-MM" for a month at `offset` months from now (0 = this month). */
const monthIso = (offset: number): string => {
  const d = new Date();
  const shifted = new Date(d.getFullYear(), d.getMonth() - offset, 1);
  return `${shifted.getFullYear()}-${String(shifted.getMonth() + 1).padStart(2, "0")}`;
};

/** Trading performance review (accounting × Binance) entry form on the
 *  Workbench landing. Typing is optional: the preset chips run immediately
 *  with a concrete month, and an empty Review defaults to the LAST MONTH
 *  (the natural "how did I do?" period — the current month is incomplete).
 *  The goal routes through the deterministic router's `trading_performance`
 *  template: fetch every exchange's fills (Binance's stats tool is also its
 *  sync; MEXC is best-effort when unconfigured) → post to the books →
 *  per-pair PnL → fees → integrity gate. The plan lands in the review gate —
 *  nothing runs before it is approved. */
export function TradingPerformanceForm({ disabled, onSubmit }: TradingPerformanceFormProps) {
  const [period, setPeriod] = useState("");
  const [venue, setVenue] = useState<TradingVenue | undefined>(undefined);

  const runWith = (value: string) => {
    if (!value || disabled) return;
    setPeriod(value);
    // Undefined venue → the field is left out of the command entirely.
    onSubmit(value, venue);
  };

  const submit = () => {
    // Lazy default: an empty review means the last completed month.
    runWith(period.trim() || monthIso(1));
  };
  const presets: { label: string; value: string }[] = [
    { label: "Bulan ini", value: monthIso(0) },
    { label: "Bulan lalu", value: monthIso(1) },
  ];

  return (
    <PeriodSubmitCard
      buttonDisabled={disabled}
      buttonLabel="Review"
      disabled={disabled}
      icon="chart-line"
      onSubmit={submit}
      period={period}
      setPeriod={setPeriod}
      subtitle="sync · win rate · per-pair PnL · fees · integrity gate"
      title="Trading Performance"
    >
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {presets.map((p) => (
          <button
            key={p.label}
            type="button"
            onClick={() => runWith(p.value)}
            disabled={disabled}
            className="border-border/60 text-muted-foreground hover:border-[var(--tea-color-border-focus)] hover:text-foreground rounded-full border px-3 py-1 font-mono text-[0.625rem] tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
          >
            {p.label} · {p.value}
          </button>
        ))}
        <span className="text-muted-foreground ml-auto font-mono text-[0.625rem]">kosong = bulan lalu</span>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground font-mono text-[0.625rem] tracking-wider uppercase">Exchange</span>
        {VENUES.map((v) => (
          <button
            key={v.label}
            type="button"
            onClick={() => setVenue(v.value)}
            disabled={disabled}
            aria-pressed={venue === v.value}
            className={`rounded-full border px-3 py-1 font-mono text-[0.625rem] tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              venue === v.value
                ? "border-[var(--tea-color-border-focus)] text-foreground bg-primary/10"
                : "border-border/60 text-muted-foreground hover:border-[var(--tea-color-border-focus)] hover:text-foreground"
            }`}
          >
            {v.label}
          </button>
        ))}
      </div>
      <p className="text-muted-foreground mt-2 font-mono text-[0.625rem]">
        {venue === "mexc"
          ? "MEXC: pembukuan saja — import fill + PnL + biaya. Statistik win rate masih Binance-only, jadi langkah itu dilewati."
          : venue === "binance"
            ? "Binance saja — import fill, win rate, PnL per pair, dan biaya."
            : "Semua exchange: default — fill dari setiap exchange yang punya kunci."}
      </p>
      <p className="text-muted-foreground mt-2 font-mono text-[0.625rem]">
        Lands in the review gate — the plan runs only after you approve it.
      </p>
    </PeriodSubmitCard>
  );
}
