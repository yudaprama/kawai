import { useState } from "react";

import { Icon } from "@/components/shared/icon";

export interface BookCloseFormProps {
  disabled?: boolean;
  onSubmit: (period: string) => void;
}

/** Monthly book close (accounting) entry form on the Workbench landing. The
 *  period is free text — the backend parser accepts "Oktober 2026",
 *  "2026-10", "31/10/26", or a bare month name (last occurrence). The goal
 *  routes through the deterministic router's `accounting_monthly_close`
 *  template: collect the month's transactions, build the four statements,
 *  gate on the integrity check, then export GSTR-1. The plan lands in the
 *  review gate — nothing runs before it is approved. */
export function BookCloseForm({ disabled, onSubmit }: BookCloseFormProps) {
  const [period, setPeriod] = useState("");

  const submit = () => {
    const value = period.trim();
    if (!value || disabled) return;
    onSubmit(value);
  };

  return (
    <div className="border-border/60 w-full rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="book-check" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">Monthly Close</span>
        <span className="text-muted-foreground font-mono text-[0.625rem]">statements · integrity gate · GSTR-1</span>
      </div>
      <div className="flex gap-2">
        <input
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="Oktober 2026 · 2026-10 · 31/10/26"
          disabled={disabled}
          spellCheck={false}
          className="border-border bg-background text-foreground placeholder:text-muted-foreground/60 min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-sm outline-none focus:border-[var(--tea-color-border-focus)] focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !period.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-lg px-4 py-2 font-mono text-xs font-bold tracking-wider uppercase transition-colors disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Icon name="zap" className="size-3.5" />
          Close books
        </button>
      </div>
      <p className="text-muted-foreground mt-2 font-mono text-[0.625rem]">
        Lands in the review gate — the plan runs only after you approve it.
      </p>
    </div>
  );
}
