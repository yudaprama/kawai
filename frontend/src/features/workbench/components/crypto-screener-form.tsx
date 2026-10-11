import { useState } from "react";

import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";

/** The screens the fixed pipeline accepts (mirrors the backend's
 * `screener_plan::valid_screens`). Order here is the display order; the run
 * dispatches one parallel `crypto_screener` step per picked screen. */
const SCREENS: { id: string; label: string; hint: string }[] = [
  { id: "oversold_rebound", label: "Oversold rebound", hint: "RSI turning up + volume + green candle" },
  { id: "macd_golden_cross", label: "MACD golden cross", hint: "crossed above signal ≤3 bars ago" },
  { id: "macd_death_cross", label: "MACD death cross", hint: "crossed below signal ≤3 bars ago" },
  { id: "midband_reclaim", label: "Mid-band reclaim", hint: "close back above the SMA20" },
  { id: "uptrend_pullback", label: "Uptrend pullback", hint: "dip on thin volume in a rising trend" },
  { id: "squeeze_watch", label: "Squeeze watch", hint: "BB inside KC, low efficiency ratio" },
  { id: "rsi_overbought_uptrend", label: "Overbought uptrend", hint: "late-cycle exhaustion warning" },
];

/** Market family — mirrors the backend's `SCREENER_UNIVERSES`. */
const UNIVERSES = [
  { id: "usdm", label: "Perp (USDⓈ-M)" },
  { id: "spot", label: "Spot" },
] as const;

/** Candle intervals the screens fold on. Anything else falls back to `1d`
 * server-side (and `1s` is spot-only — the backend rejects it for perp). */
const INTERVALS = ["15m", "1h", "4h", "1d", "1w"] as const;

/** Hits returned per screen (the backend clamps 1-25). */
const TOP_NS = [5, 10, 25] as const;

/** At most seven screens per run — the full catalog. The single-scan
 * multi-screen tool evaluates every screen over ONE set of klines, so a
 * screen beyond the first costs arithmetic only. Mirrors the backend, whose
 * catalog is the cap. */
const MAX_SCREENS = SCREENS.length;

export interface CryptoScreenerFormProps {
  disabled?: boolean;
  onSubmit: (screens: string[], universe: string, interval: string, topN: number) => void;
}

/** Crypto Screener entry form on the Workbench landing. Pick up to four
 * setups, a market family, and the candle interval — the pipeline itself is
 * fixed: one `crypto_screener` scan per picked screen (parallel), then the
 * built-in deliverable writer. No planning round: the screens are already
 * deterministic Rust, and keyless public endpoints need no credentials. */
export function CryptoScreenerForm({ disabled, onSubmit }: CryptoScreenerFormProps) {
  const [screens, setScreens] = useState<string[]>(["macd_golden_cross"]);
  const [universe, setUniverse] = useState<string>("usdm");
  const [interval, setInterval] = useState<string>("1d");
  const [topN, setTopN] = useState<number>(10);

  const toggleScreen = (id: string) => {
    setScreens((prev) => {
      if (prev.includes(id)) return prev.filter((s) => s !== id);
      if (prev.length >= MAX_SCREENS) return prev;
      return [...prev, id];
    });
  };

  const submit = () => {
    if (disabled || screens.length === 0) return;
    onSubmit(screens, universe, interval, topN);
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
        <Icon name="scan-search" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">Crypto Screener</span>
        <span className="text-muted-foreground font-mono text-[10px]">fixed pipeline · no planning round</span>
      </div>

      <div className="flex flex-col gap-3">
        <Field label={`Setups (${screens.length}/${MAX_SCREENS})`}>
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              disabled={disabled}
              aria-pressed={screens.length === SCREENS.length}
              onClick={() => setScreens(screens.length === SCREENS.length ? [SCREENS[0].id] : SCREENS.map((s) => s.id))}
              title="Scan every setup over one shared market scan"
              className={chip(screens.length === SCREENS.length)}
            >
              All setups
            </button>
            {SCREENS.map((s) => {
              const active = screens.includes(s.id);
              const blocked = !active && screens.length >= MAX_SCREENS;
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={disabled || blocked}
                  aria-pressed={active}
                  onClick={() => toggleScreen(s.id)}
                  title={`${s.label} — ${s.hint}`}
                  className={chip(active)}
                >
                  {s.label}
                </button>
              );
            })}
          </div>
        </Field>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Field label="Market">
            {UNIVERSES.map((u) => (
              <button
                key={u.id}
                type="button"
                disabled={disabled}
                aria-pressed={universe === u.id}
                onClick={() => setUniverse(u.id)}
                className={chip(universe === u.id)}
              >
                {u.label}
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

          <Field label="Hits per setup">
            {TOP_NS.map((n) => (
              <button
                key={n}
                type="button"
                disabled={disabled}
                aria-pressed={topN === n}
                onClick={() => setTopN(n)}
                className={chip(topN === n)}
              >
                {n}
              </button>
            ))}
          </Field>
        </div>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={submit}
          disabled={disabled || screens.length === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-mono text-xs font-bold tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="zap" className="size-3.5" />
          Scan market
        </button>
        <span className="text-muted-foreground font-mono text-[10px]">
          {screens.length} scan{screens.length === 1 ? "" : "s"} run in parallel
        </span>
      </div>

      <p className="text-muted-foreground mt-3 font-mono text-[10px] leading-relaxed">
        Read-only market scan over Binance public data (top-liquidity USDT pairs): ranks symbols by 24h volume, folds
        indicators per symbol, and reports every hit with a conviction score and reasons. No API keys needed — the scan
        never places an order. Symbols hitting multiple setups are called out first in the report.
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground font-mono text-[10px] tracking-wider uppercase">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}
