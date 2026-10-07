import { Button } from "@/components/ui/button";
import { Icon } from "@/components/shared/icon";
import { Spinner } from "@/components/ui/spinner";
import { emitOpenTopup } from "@/features/topup/open-topup";
import { peekFreshTokenBalance, publishTokenBalance, useTokenBalance } from "@/features/topup/use-token-balance";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";

/** What the cost quote is currently able to say about the form. */
export type QuoteState = "idle" | "pending" | "quoted" | "failed";

/**
 * Publish the post-spend balance into the shared store. A media debit moves
 * the balance without firing any of the store's own refresh triggers (those
 * cover the LLM turn, top-up claims and window focus), so the header chip
 * would otherwise keep showing the pre-spend figure until the user refocuses
 * the window. Display-only: the server-side debit inside each submit op stays
 * the authoritative gate.
 */
export function publishMediaDebit(debitedTokens: number): void {
  const current = peekFreshTokenBalance();
  if (current === null) return;
  publishTokenBalance(Math.max(0, current - debitedTokens));
}

/**
 * The lanes' action footer: the cost quote beside Generate, the user's token
 * balance beside the quote, and the free-whatif warnings that explain a
 * rejected pick BEFORE any Buzz is spent.
 *
 * The balance is display-only guidance — Generate is disabled ONLY when a
 * settled read says the balance can't cover the quote. An unreadable balance
 * leaves the button live, because the authoritative fail-closed gate is the
 * server-side debit inside the submit op.
 */
export function GenerateFooter({
  canSubmit,
  disabledReason,
  inFlight = false,
  inFlightLabel,
  note,
  onSubmit,
  quote,
  quoteState,
  ready = true,
  submitting,
  submittingLabel,
  submitLabel,
  warnings = [],
}: {
  canSubmit: boolean;
  /** Why the button is disabled — stated under the footer so a greyed
   *  Generate is never a dead end. Null when the form is submittable. */
  disabledReason?: string | null;
  /** A workflow is rendering server-side — the form stays editable. */
  inFlight?: boolean;
  /** Button label while `inFlight`; falls back to `submitLabel`. */
  inFlightLabel?: string;
  note: string;
  onSubmit: () => void;
  /** Token quote for the current form — `null` until it lands. */
  quote: number | null;
  quoteState: QuoteState;
  /** Whatif readiness — `false` means the orchestrator reports a missing
   *  capability for this pick (queue support). Warns; does not block. */
  ready?: boolean;
  submitting: boolean;
  submittingLabel: string;
  submitLabel: string;
  warnings?: string[];
}) {
  const { t } = useI18n();
  const { tokens: balance } = useTokenBalance();
  const short = quote !== null && balance !== null && balance < quote;
  // A failed quote blocks (submit re-runs the same pre-flight and would fail
  // too). `!ready` does NOT: it is the orchestrator reporting a missing
  // capability (queue support), not a verdict on this pick — so it warns
  // loudly and lets the user try. An unreadable balance is likewise not
  // evidence of a shortfall; the server-side debit is what refuses.
  const blocked = short || quoteState === "failed";
  const submitDisabled = !canSubmit || submitting || blocked;
  // A disabled button with no stated reason is a dead end — say which field
  // is missing instead of leaving the user guessing.
  const shownReason = blocked ? null : !canSubmit || submitting ? disabledReason : null;

  return (
    <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card p-3 lg:static lg:inset-auto">
      <div className="flex items-stretch gap-2">
        <div
          className={cn(
            "flex h-10 shrink-0 items-center gap-1 rounded-[8px] border bg-secondary px-2.5",
            short && "border-destructive/50",
          )}
          title={t("generator.estimate")}
        >
          {quoteState === "failed" ? (
            <Icon className="text-destructive size-4" name="info" />
          ) : quoteState === "quoted" && quote !== null ? (
            <>
              <Icon className="text-warning size-3.5" name="zap" />
              <span className={cn("text-[13px] font-semibold", short ? "text-destructive" : "text-warning")}>
                ≈{quote.toLocaleString("id-ID")}
              </span>
            </>
          ) : quoteState === "pending" ? (
            <Spinner className="size-3.5" />
          ) : null}
        </div>
        <Button
          className="h-10 flex-1 rounded-[8px] text-[15px] font-semibold"
          disabled={submitDisabled}
          onClick={onSubmit}
          size="lg"
        >
          {submitting ? (
            <span className="flex items-center gap-2">
              <Spinner className="size-4" />
              {submittingLabel}
            </span>
          ) : inFlight ? (
            (inFlightLabel ?? submitLabel)
          ) : (
            submitLabel
          )}
        </Button>
      </div>
      {/* Balance line — the shortfall case replaces the formula note with the
          one thing the user has to act on. */}
      {short ? (
        <div className="mt-1.5 flex items-center justify-center gap-2 text-[11px]">
          <span className="text-destructive">
            {t("generator.balanceShort", {
              balance: (balance ?? 0).toLocaleString("id-ID"),
              cost: (quote ?? 0).toLocaleString("id-ID"),
            })}
          </span>
          <button className="text-primary underline-offset-2 hover:underline" onClick={emitOpenTopup} type="button">
            {t("topUp.title")}
          </button>
        </div>
      ) : shownReason ? (
        <p className="text-muted-foreground mt-1.5 line-clamp-2 text-center text-[11px]">{shownReason}</p>
      ) : (
        <p className="text-muted-foreground/70 mt-1.5 text-center text-[10px]">{note}</p>
      )}
      {/* Whatif warnings — the only pre-spend signal that a pick is wrong. */}
      {quoteState === "failed" ? (
        <p className="text-destructive mt-1.5 text-center text-[10px]">{t("generator.quoteFailedHint")}</p>
      ) : !ready ? (
        <p className="text-destructive mt-1.5 text-center text-[11px]">{warnings[0] ?? t("generator.quoteNotReady")}</p>
      ) : warnings.length > 0 ? (
        <p className="text-muted-foreground mt-1.5 line-clamp-2 text-center text-[10px]">{warnings.join(" · ")}</p>
      ) : null}
    </div>
  );
}
