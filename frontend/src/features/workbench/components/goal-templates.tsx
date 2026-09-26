import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";

export type GoalTemplateId = "research" | "market" | "coding" | "data";

const GOAL_TEMPLATES: { id: GoalTemplateId; label: string }[] = [
  { id: "research", label: "Research" },
  { id: "market", label: "Market Analysis" },
  { id: "coding", label: "Coding" },
  { id: "data", label: "Data Analysis" },
];

/** Templates whose workflow includes the fixed-pipeline Analysis Desk — only
 *  these disclose the desk panel on the landing (progressive disclosure: the
 *  desk never sits uninvited under the goal composer). */
const DESK_TEMPLATES: readonly GoalTemplateId[] = ["research", "market"];

export const templateOpensDesk = (t: GoalTemplateId | null): boolean => t != null && DESK_TEMPLATES.includes(t);

/** Contextual composer framing per template. Desk templates keep the default
 *  goal placeholder — the desk panel is their framing. */
const PLACEHOLDERS: Partial<Record<GoalTemplateId, string>> = {
  coding: "Describe what to build — language, target, constraints…",
  data: "Describe the data and the question to answer…",
};

export const placeholderForTemplate = (t: GoalTemplateId | null): string | undefined =>
  t != null ? PLACEHOLDERS[t] : undefined;

export interface GoalTemplatesProps {
  value: GoalTemplateId | null;
  disabled?: boolean;
  onChange: (t: GoalTemplateId | null) => void;
}

/** Landing template chips — single-select, click the active one to clear.
 *  Picking a research-flavored template discloses the Analysis Desk panel
 *  below the composer; the rest only reframe the composer's placeholder. */
export function GoalTemplates({ value, disabled, onChange }: GoalTemplatesProps) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="text-muted-foreground font-mono text-[10px] tracking-widest uppercase">Templates</span>
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
                "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 font-mono text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50",
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
