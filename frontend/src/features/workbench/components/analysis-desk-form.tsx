import { useState } from "react";

import { Icon } from "@/components/shared/icon";

/** The four analyst roles (mirror of the backend's ANALYSTS). */
const ANALYSTS: { id: string; label: string; hint: string }[] = [
  { id: "market", label: "Market", hint: "price, volume, technicals" },
  { id: "social", label: "Social", hint: "reddit, sentiment" },
  { id: "news", label: "News", hint: "headlines, sentiment" },
  { id: "fundamentals", label: "Fundamentals", hint: "financials, earnings, insiders" },
];

export interface AnalysisDeskFormProps {
  disabled?: boolean;
  onSubmit: (ticker: string, tradeDate: string | undefined, analysts: string[] | undefined) => void;
}

/** Analysis Desk (PLAN-analysis-desk) entry form on the Workbench landing.
 *  A ticker, an optional as-of date, and the analyst team — submit runs the
 *  FIXED research pipeline (analysts → debate → research manager → trader →
 *  risk debate → PM) through the supervisor scheduler. No planning round:
 *  the pipeline shape is the product. */
export function AnalysisDeskForm({ disabled, onSubmit }: AnalysisDeskFormProps) {
  const [ticker, setTicker] = useState("");
  const [tradeDate, setTradeDate] = useState("");
  const [selected, setSelected] = useState<string[]>(ANALYSTS.map((a) => a.id));
  const [open, setOpen] = useState(false);

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = () => {
    const sym = ticker.trim().toUpperCase();
    if (!sym || selected.length === 0 || disabled) return;
    const date = tradeDate.trim() || undefined;
    const analysts = selected.length === ANALYSTS.length ? undefined : selected;
    onSubmit(sym, date, analysts);
  };

  return (
    <div className="border-border/60 w-full rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="activity" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">Analysis Desk</span>
        <span className="text-muted-foreground font-mono text-[10px]">fixed research pipeline · no planning round</span>
      </div>
      <div className="flex gap-2">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="TICKER (e.g. AAPL)"
          disabled={disabled}
          spellCheck={false}
          className="border-border bg-background text-foreground placeholder:text-muted-foreground/60 min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm uppercase outline-none focus:border-[var(--tea-color-border-focus)]"
        />
        <input
          value={tradeDate}
          onChange={(e) => setTradeDate(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="as of (YYYY-MM-DD, optional)"
          disabled={disabled}
          spellCheck={false}
          className="border-border bg-background text-foreground placeholder:text-muted-foreground/60 w-56 rounded-lg border px-3 py-2 font-mono text-xs outline-none focus:border-[var(--tea-color-border-focus)]"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !ticker.trim() || selected.length === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-mono text-xs font-bold tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="zap" className="size-3.5" />
          Run desk
        </button>
      </div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="text-muted-foreground hover:text-foreground mt-3 font-mono text-[10px] tracking-wider uppercase"
      >
        Analyst team ({selected.length}/{ANALYSTS.length}) {open ? "▾" : "▸"}
      </button>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-2">
          {ANALYSTS.map((a) => {
            const on = selected.includes(a.id);
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => toggle(a.id)}
                className={`border-border flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition-colors ${
                  on ? "bg-primary/10 border-primary/40" : "hover:bg-[var(--tea-color-bg-secondary-default)]"
                }`}
              >
                <span
                  className={`mt-0.5 inline-block size-3 shrink-0 rounded-sm border ${
                    on ? "bg-primary border-primary" : "border-muted-foreground/50"
                  }`}
                />
                <span className="min-w-0">
                  <span className="text-foreground block font-mono text-xs font-bold">{a.label}</span>
                  <span className="text-muted-foreground block font-mono text-[10px]">{a.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
