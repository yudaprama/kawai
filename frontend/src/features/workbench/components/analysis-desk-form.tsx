import { useState } from "react";

import { Icon } from "@/components/shared/icon";

/** The four analyst roles (mirror of the backend's ANALYSTS). */
const ANALYSTS: { id: string; label: string; hint: string }[] = [
  { id: "market", label: "Market", hint: "price, volume, technicals" },
  { id: "social", label: "Social", hint: "reddit, sentiment" },
  { id: "news", label: "News", hint: "headlines, sentiment" },
  { id: "fundamentals", label: "Fundamentals", hint: "financials, earnings, insiders" },
];

/** Per-domain copy + examples. `domain` is the USER's asset-class choice
 *  (mirrors the backend's DOMAINS) — it routes the pipeline's data sources
 *  and prompt variants; it is never guessed from the ticker. */
export type DeskDomain = "stock" | "crypto" | "commodity" | "forex";

const DOMAIN_COPY: Record<DeskDomain, { title: string; tickerPlaceholder: string; button: string }> = {
  stock: {
    title: "Stock Research",
    tickerPlaceholder: "TICKER (e.g. AAPL)",
    button: "Run research",
  },
  crypto: {
    title: "Crypto Research",
    tickerPlaceholder: "SYMBOL (e.g. BTC)",
    button: "Run research",
  },
  commodity: {
    title: "Commodity Research",
    tickerPlaceholder: "COMMODITY (e.g. XAU, WTI)",
    button: "Run research",
  },
  forex: {
    title: "Forex Research",
    tickerPlaceholder: "PAIR (e.g. EUR, EURUSD)",
    button: "Run research",
  },
};

export interface StockResearchFormProps {
  disabled?: boolean;
  /** Asset class for this desk run — set by the active landing template
   *  (Stock / Crypto / Commodity Research). */
  domain?: DeskDomain;
  onSubmit: (ticker: string, tradeDate: string | undefined, analysts: string[] | undefined, domain: DeskDomain) => void;
}

/** Stock/Crypto Research (PLAN-stock-research) entry form on the Workbench
 *  landing. A ticker, an optional as-of date, and the analyst team — submit
 *  runs the FIXED research pipeline (analysts → debate → research manager →
 *  trader → risk debate → PM) through the supervisor scheduler. No planning
 *  round: the pipeline shape is the product. The active template's domain
 *  decides which data sources and prompt variants the pipeline uses. */
export function StockResearchForm({ disabled, domain = "stock", onSubmit }: StockResearchFormProps) {
  const [ticker, setTicker] = useState("");
  const [tradeDate, setTradeDate] = useState("");
  const [selected, setSelected] = useState<string[]>(ANALYSTS.map((a) => a.id));
  const [open, setOpen] = useState(false);
  const copy = DOMAIN_COPY[domain];

  const toggle = (id: string) =>
    setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const submit = () => {
    const sym = ticker.trim().toUpperCase();
    if (!sym || selected.length === 0 || disabled) return;
    const date = tradeDate.trim() || undefined;
    const analysts = selected.length === ANALYSTS.length ? undefined : selected;
    onSubmit(sym, date, analysts, domain);
  };

  return (
    <div className="border-border/60 w-full rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="activity" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">{copy.title}</span>
        <span className="text-muted-foreground font-mono text-[10px]">fixed research pipeline · no planning round</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          value={ticker}
          onChange={(e) => setTicker(e.target.value.toUpperCase())}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder={copy.tickerPlaceholder}
          disabled={disabled}
          spellCheck={false}
          className="border-border bg-background text-foreground placeholder:text-muted-foreground/60 min-w-[12rem] flex-1 basis-full rounded-lg border px-3 py-2 font-mono text-sm uppercase outline-none focus:border-[var(--tea-color-border-focus)] focus-visible:ring-2 focus-visible:ring-ring/50 sm:basis-auto"
        />
        <input
          value={tradeDate}
          onChange={(e) => setTradeDate(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          type="date"
          disabled={disabled}
          spellCheck={false}
          className="border-border bg-background text-foreground placeholder:text-muted-foreground/60 w-full min-w-[10rem] rounded-lg border px-3 py-2 font-mono text-xs outline-none focus:border-[var(--tea-color-border-focus)] focus-visible:ring-2 focus-visible:ring-ring/50 sm:w-56"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !ticker.trim() || selected.length === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-mono text-xs font-bold tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="zap" className="size-3.5" />
          {copy.button}
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
