import { useState } from "react";

import { PeriodSubmitCard } from "./workbench-ui";

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
    <PeriodSubmitCard
      buttonDisabled={disabled || !period.trim()}
      buttonLabel="Close books"
      disabled={disabled}
      icon="book-check"
      onSubmit={submit}
      period={period}
      setPeriod={setPeriod}
      subtitle="statements · integrity gate · GSTR-1"
      title="Monthly Close"
    >
      <p className="text-muted-foreground mt-2 font-mono text-[0.625rem]">
        Lands in the review gate — the plan runs only after you approve it.
      </p>
    </PeriodSubmitCard>
  );
}
