import { useState } from "react";

import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";

const BUDGETS = [
  { id: "eco", label: "eco · ≤120k tokens" },
  { id: "balanced", label: "balanced · ≤250k" },
  { id: "aggressive", label: "aggressive · ≤800k" },
] as const;

/** NeuroSploit Deep Audit intake. The cost ceiling is part of the form:
 *  unlike the fast security lane this is a confirmation-gated, minutes-long
 *  multi-model engagement that spends gateway tokens from the user's balance.
 */
export function DeepAuditForm({
  disabled,
  onSubmit,
}: {
  disabled?: boolean;
  onSubmit: (target: string, budget: string | undefined, resume: boolean) => void;
}) {
  const [target, setTarget] = useState("");
  const [budget, setBudget] = useState<(typeof BUDGETS)[number]["id"]>("eco");
  const [resume, setResume] = useState(false);

  const submit = () => {
    const value = target.trim();
    if (!value || disabled) return;
    onSubmit(value, budget === "eco" ? undefined : budget, resume);
  };

  return (
    <div className="border-border/60 w-full rounded-xl border p-4">
      <div className="mb-3 flex items-center gap-2">
        <Icon name="shield" className="text-primary size-4" />
        <span className="text-foreground font-mono text-xs font-bold tracking-wider uppercase">Deep Audit</span>
        <span className="text-muted-foreground font-mono text-[0.625rem]">neurosploit · autonomous engagement</span>
      </div>
      <div className="flex gap-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
          placeholder="https://example.com"
          aria-label="Origin to deep-audit"
          disabled={disabled}
          className={cn(
            "border-input bg-background placeholder:text-muted-foreground min-w-0 flex-1 rounded-md border px-3 py-1.5 font-mono text-xs outline-none",
            "focus:ring-ring focus:ring-1",
          )}
        />
        <button
          type="button"
          onClick={submit}
          disabled={disabled || !target.trim()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 font-mono text-xs font-bold disabled:opacity-50"
        >
          Deep audit
        </button>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="text-muted-foreground flex items-center gap-1.5 font-mono text-[0.625rem]">
          ceiling
          <select
            value={budget}
            onChange={(e) => setBudget(e.target.value as (typeof BUDGETS)[number]["id"])}
            disabled={disabled}
            className="border-input bg-background rounded-md border px-2 py-1 font-mono text-[0.625rem]"
          >
            {BUDGETS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-muted-foreground flex items-center gap-1.5 font-mono text-[0.625rem]">
          <input
            type="checkbox"
            checked={resume}
            onChange={(e) => setResume(e.target.checked)}
            disabled={disabled}
            className="size-3"
          />
          resume last run
        </label>
      </div>
      <p className="text-muted-foreground mt-2 font-mono text-[0.625rem] leading-snug">
        Only origins you own or are authorized to test. You will be asked to confirm before any request is fired; up to
        the selected token ceiling is spent from your balance.
      </p>
    </div>
  );
}
