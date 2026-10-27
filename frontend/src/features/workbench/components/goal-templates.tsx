import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";

export type GoalTemplateId =
  | "stock"
  | "crypto"
  | "commodity"
  | "forex"
  | "youtube"
  | "binanceAudit"
  | "cryptoScreener"
  | "bookClose"
  | "tradingPerformance"
  | "securityAudit";
const GOAL_TEMPLATES: { id: GoalTemplateId; label: string }[] = [
  { id: "stock", label: "Stock Research" },
  { id: "crypto", label: "Crypto Research" },
  { id: "commodity", label: "Commodity Research" },
  { id: "forex", label: "Forex Research" },
  { id: "youtube", label: "YouTube Summary" },
  { id: "binanceAudit", label: "Futures Risk Audit" },
  { id: "cryptoScreener", label: "Crypto Screener" },
  { id: "bookClose", label: "Monthly Close" },
  { id: "tradingPerformance", label: "Trading Performance" },
  { id: "securityAudit", label: "Security Audit" },
];

/** Templates whose workflow includes the fixed-pipeline Stock Research — only
 *  these disclose the desk panel on the landing (progressive disclosure: the
 *  desk never sits uninvited under the goal composer). */
const DESK_TEMPLATES: readonly GoalTemplateId[] = ["stock", "crypto", "commodity", "forex"];
export const templateOpensDesk = (t: GoalTemplateId | null): boolean => t != null && DESK_TEMPLATES.includes(t);

/** Templates whose workflow is the fixed-pipeline YouTube Summary (a link in,
 *  a five-section summary out — no planning round). Discloses its URL form
 *  the same way research templates disclose the desk panel. */
const YOUTUBE_TEMPLATES: readonly GoalTemplateId[] = ["youtube"];

export const templateOpensYoutube = (t: GoalTemplateId | null): boolean => t != null && YOUTUBE_TEMPLATES.includes(t);

/** Templates whose workflow is the fixed Binance Futures Risk Audit — the
 * form discloses the audit presets (candle interval, stop distance, how many
 * positions to grade) the same way the other fixed pipelines disclose theirs. */
const AUDIT_TEMPLATES: readonly GoalTemplateId[] = ["binanceAudit"];

export const templateOpensAudit = (t: GoalTemplateId | null): boolean => t != null && AUDIT_TEMPLATES.includes(t);

/** Templates whose workflow is the fixed Crypto Screener — the form discloses
 * the screen selection and scan presets the same way the other fixed
 * pipelines disclose theirs. */
const SCREENER_TEMPLATES: readonly GoalTemplateId[] = ["cryptoScreener"];

export const templateOpensScreener = (t: GoalTemplateId | null): boolean => t != null && SCREENER_TEMPLATES.includes(t);

/** Templates whose workflow is the accounting monthly close: the goal routes
 * through the deterministic router's `accounting_monthly_close` template
 * (collect → four statements → integrity gate → GSTR-1) and the resulting
 * plan lands in the review gate — nothing runs before approval. */
const BOOK_CLOSE_TEMPLATES: readonly GoalTemplateId[] = ["bookClose"];

export const templateOpensBookClose = (t: GoalTemplateId | null): boolean =>
  t != null && BOOK_CLOSE_TEMPLATES.includes(t);

/** Templates whose workflow is the trading performance review: the goal
 * routes through the deterministic router's `trading_performance` template
 * (fetch every exchange's fills → post to books → per-pair PnL → fees →
 * integrity gate) and the resulting plan lands in the review gate — nothing
 * runs before approval. */
const TRADING_PERFORMANCE_TEMPLATES: readonly GoalTemplateId[] = ["tradingPerformance"];

export const templateOpensTradingPerformance = (t: GoalTemplateId | null): boolean =>
  t != null && TRADING_PERFORMANCE_TEMPLATES.includes(t);

/** Templates whose workflow is the fixed Security Audit — the form discloses
 *  the target, category selection and intensity presets like every other
 *  fixed pipeline. The plan lands in the review gate; each ACTIVE scan step
 *  then asks for its own confirmation (one approval = one scan). */
const SECURITY_AUDIT_TEMPLATES: readonly GoalTemplateId[] = ["securityAudit"];

export const templateOpensSecurityAudit = (t: GoalTemplateId | null): boolean =>
  t != null && SECURITY_AUDIT_TEMPLATES.includes(t);

/** Contextual composer framing per template. Desk templates keep the default
 * goal placeholder — the desk panel is their framing. */
export const placeholderForTemplate = (_t: GoalTemplateId | null): string | undefined => undefined;

/** Each template's deep-dive page on kawai.pro. The four research chips open
 *  ONE page — Stock/Crypto/Commodity/Forex are the same pipeline over
 *  different data sources. No chip selected falls back to the workflow hub. */
const DOCS_FOR_TEMPLATE: Record<GoalTemplateId, string> = {
  stock: "https://kawai.pro/workflows/research/",
  crypto: "https://kawai.pro/workflows/research/",
  commodity: "https://kawai.pro/workflows/research/",
  forex: "https://kawai.pro/workflows/research/",
  youtube: "https://kawai.pro/workflows/youtube-summary/",
  binanceAudit: "https://kawai.pro/workflows/futures-risk-audit/",
  cryptoScreener: "https://kawai.pro/workflows/",
  bookClose: "https://kawai.pro/workflows/",
  tradingPerformance: "https://kawai.pro/workflows/",
  securityAudit: "https://kawai.pro/workflows/",
};

export const docsUrlForTemplate = (t: GoalTemplateId | null): string =>
  t ? DOCS_FOR_TEMPLATE[t] : "https://kawai.pro/workflows/";

export interface GoalTemplatesProps {
  value: GoalTemplateId | null;
  disabled?: boolean;
  onChange: (t: GoalTemplateId | null) => void;
}

export function GoalTemplates({ value, disabled, onChange }: GoalTemplatesProps) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-muted-foreground font-mono text-[0.625rem] tracking-widest uppercase">Templates</span>
      <a
        href={docsUrlForTemplate(value)}
        target="_blank"
        rel="noreferrer"
        className="text-primary inline-flex items-center gap-1 font-mono text-[0.6875rem] underline underline-offset-4 decoration-primary/40 hover:decoration-primary transition-colors"
      >
        <Icon name="external-link" className="size-3" />
        How these workflows work
      </a>
      <div className="flex flex-wrap gap-1.5">
        {GOAL_TEMPLATES.map((t) => {
          const active = value === t.id;
          return (
            <button
              key={t.id}
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onChange(active ? null : t.id)}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[0.6875rem] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                active
                  ? "border-primary/60 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:border-[var(--tea-color-border-focus)] hover:text-foreground",
              )}
            >
              <Icon name={active ? "circle-check" : "circle"} className="size-3" />
              {t.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
