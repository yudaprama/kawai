import type { ReactNode } from "react";

import { Icon } from "@/components/shared/icon";

/** Mono label + inline control row — the shared workbench form field idiom. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground font-mono text-[0.625rem] tracking-wider uppercase">{label}</span>
      <div className="flex items-center gap-1">{children}</div>
    </div>
  );
}

/** Card shell for the Workbench landing entry forms: icon header, free-text
 *  period input, submit button. Whatever the specific form appends (preset
 *  chips, venue row, footnotes) rides in as `children`, inside the card. */
export function PeriodSubmitCard({
  buttonDisabled,
  buttonLabel,
  children,
  disabled,
  icon,
  onSubmit,
  period,
  setPeriod,
  subtitle,
  title,
}: {
  buttonDisabled?: boolean;
  buttonLabel: string;
  children?: ReactNode;
  disabled?: boolean;
  icon: string;
  onSubmit: () => void;
  period: string;
  setPeriod: (value: string) => void;
  subtitle: string;
  title: string;
}) {
  return (
    <div className="border-border/60 w-full rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name={icon} className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">{title}</span>
        <span className="text-muted-foreground font-mono text-[0.625rem]">{subtitle}</span>
      </div>
      <div className="flex gap-2">
        <input
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder="Oktober 2026 · 2026-10 · 31/10/26"
          disabled={disabled}
          spellCheck={false}
          className="border-border bg-background text-foreground placeholder:text-muted-foreground/60 min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:border-[var(--tea-color-border-focus)] focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <button
          type="button"
          onClick={onSubmit}
          disabled={buttonDisabled ?? false}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-mono text-xs font-bold tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="zap" className="size-3.5" />
          {buttonLabel}
        </button>
      </div>
      {children}
    </div>
  );
}

/** Symbol filter box above an offer's selection table. */
export function SymbolSearch({
  ariaLabel,
  onQuery,
  query,
}: {
  ariaLabel: string;
  onQuery: (value: string) => void;
  query: string;
}) {
  return (
    <input
      type="search"
      value={query}
      onChange={(e) => onQuery(e.target.value)}
      placeholder="Cari simbol… (mis. BTC)"
      aria-label={ariaLabel}
      className="border-input bg-input/20 h-7 w-44 rounded-md border px-2 font-mono text-[0.6875rem] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
    />
  );
}

/** Right-aligned "N of M" counter for a filtered selection list. */
export function MatchCount({
  filtered,
  matchCount,
  total,
  unit,
}: {
  filtered: boolean;
  matchCount: number;
  total: number;
  unit: string;
}) {
  return (
    <span className="text-muted-foreground ml-auto font-mono text-[0.6875rem] tabular-nums">
      {filtered ? `${matchCount} of ${total}` : `${total} ${unit}`}
    </span>
  );
}

/** Bulk-select link under the filter row of an offer's selection table. */
export function SelectMatchingButton({
  disabled,
  matchCount,
  onClick,
  selectedInView,
}: {
  disabled: boolean;
  matchCount: number;
  onClick: () => void;
  selectedInView: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="text-muted-foreground hover:text-foreground text-xs underline disabled:cursor-not-allowed disabled:opacity-50"
    >
      Select the {matchCount} shown{selectedInView > 0 ? ` (${selectedInView} already selected)` : ""}
    </button>
  );
}
