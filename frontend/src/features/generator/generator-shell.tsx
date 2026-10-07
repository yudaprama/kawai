import { type ReactNode, useEffect, useRef } from "react";

import { AssetShell } from "@/features/assets/components/asset-shell";
import { Icon } from "@/components/shared/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import { type PickerGroup, PickerMenu } from "./picker-menu";

/**
 * The chrome every media lane shares: the lane's ecosystem picker, the form
 * column + results pane split, the results header, the empty state and the
 * in-flight job card.
 *
 * These were four hand-rolled copies (one per lane) that drifted: the image
 * lane painted the mode switcher with a different active-tab treatment, the
 * four results headers had three different markups, and only three lanes had
 * a job card at all. One definition here means a fix lands in all four.
 */

/** Segmented-control vocabulary — the muted track + active-pill treatment the
 *  app's ui/tabs triggers use, spelled out for these raw button groups. */
export const SEGMENTED_LIST = "inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5";

export function segmentClass(active: boolean): string {
  return cn(
    "flex h-7 items-center rounded-md px-3 text-xs font-medium transition-colors",
    active ? "bg-background text-foreground shadow-sm dark:bg-input/30" : "text-muted-foreground hover:text-foreground",
  );
}

/** Standalone choice buttons (no shared track) — bordered, active in primary. */
export function choiceClass(active: boolean): string {
  return cn(
    "rounded-[8px] border px-2.5 py-1.5 text-xs font-medium transition-colors",
    active ? "border-primary bg-secondary text-primary" : "bg-muted text-muted-foreground hover:text-foreground",
  );
}

/**
 * A single-select choice chip. Exists so `aria-pressed` is structural: the
 * image lane's chips carried it while the video/music/3D chips painted the
 * active state with color only, leaving three lanes' toggle state invisible
 * to assistive tech. Every chip now announces itself.
 */
export function ChoiceChip({
  active,
  children,
  className,
  onClick,
  title,
}: {
  active: boolean;
  children: ReactNode;
  /** Extra classes — `flex-1` for a chip row that should split the width. */
  className?: string;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      aria-pressed={active}
      className={cn(choiceClass(active), className)}
      onClick={onClick}
      title={title}
      type="button"
    >
      {children}
    </button>
  );
}

/**
 * A labelled on/off row. Built on the app's `ui/switch` so the toggles match
 * the token layer and the rest of the product — the video and 3D lanes
 * previously used bare `<input type="checkbox">`, which renders a native
 * control that ignores the theme entirely.
 */
export function ToggleRow({
  checked,
  label,
  onCheckedChange,
}: {
  checked: boolean;
  label: string;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = `gen-toggle-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className="flex items-center justify-between gap-2 text-[13px]">
      <Label className="text-muted-foreground font-medium" htmlFor={id}>
        {label}
      </Label>
      <Switch aria-label={label} checked={checked} id={id} onCheckedChange={onCheckedChange} />
    </div>
  );
}

/**
 * The lane's `Eco | <ecosystem>` picker — the one control that stays in the
 * form. Lane switching moved to the app's global mode bar (`app/mode-bar.tsx`),
 * so this is now purely "which engine family am I generating with"; its label
 * and groups are lane-specific, which is why it is not shared chrome.
 */
export function EcoPicker({
  ecoAriaLabel,
  ecoGroups,
  ecoLabel,
  ecoOpen,
  onEcoOpenChange,
}: {
  /** Lane-specific aria-label for the ecosystem picker. */
  ecoAriaLabel: string;
  ecoGroups: PickerGroup[];
  ecoLabel: string;
  ecoOpen: boolean;
  onEcoOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-end rounded-[10px] border p-1.5">
      <PickerMenu
        align="end"
        ariaLabel={ecoAriaLabel}
        groups={ecoGroups}
        onOpenChange={onEcoOpenChange}
        open={ecoOpen}
        trigger={
          <>
            <span className="text-muted-foreground">{t("generator.ecoShort")}</span>
            <span className="bg-border h-4 w-px" />
            {ecoLabel}
            <span
              className={cn("text-muted-foreground flex items-center transition-transform", ecoOpen && "rotate-180")}
            >
              <Icon name="chevron-down" />
            </span>
          </>
        }
        triggerClassName="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm font-semibold transition-colors hover:brightness-125"
      />
    </div>
  );
}

/**
 * The lane shell: a fixed-width scrolling form column with its action footer,
 * beside a results pane. Below `lg` the two stack and the page scrolls, so the
 * footer leaves the flow and pins to the viewport bottom (the `pb-24` on both
 * scroll regions keeps the last row clear of it).
 *
 * It renders a bare shell: the mode bar above already names the lane and
 * carries the way back, so a page header here would only restate them.
 */
export function GeneratorLayout({
  children,
  footer,
  form,
  header,
}: {
  children: ReactNode;
  /** The lane's `GenerateFooter` (or null while the key check is pending). */
  footer: ReactNode;
  form: ReactNode;
  /** Results-pane header contents — usually `ResultsPaneHeader`. */
  header: ReactNode;
}) {
  const shellBodyRef = useRef<HTMLDivElement>(null);
  // The AssetShell body div is a page scroller below lg (the narrow layout
  // stacks the results pane under the form), but on lg+ the lane is fully
  // pane-bound and must never scroll it — wheel chaining or reveal scrolling
  // would otherwise shift the whole shell. `clip` is not a scroll container,
  // so nothing can move it.
  useEffect(() => {
    const body = shellBodyRef.current?.parentElement;
    if (!body) return;
    const mql = window.matchMedia("(min-width: 1024px)");
    const prev = body.style.overflow;
    const apply = () => {
      body.style.overflow = mql.matches ? "clip" : "";
    };
    apply();
    mql.addEventListener("change", apply);
    return () => {
      mql.removeEventListener("change", apply);
      body.style.overflow = prev;
    };
  }, []);
  return (
    <AssetShell bare>
      <div ref={shellBodyRef} className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ── Form column — the generation panel ── */}
        <section className="flex w-full shrink-0 flex-col border-b lg:w-[400px] lg:border-r lg:border-b-0">
          <div className="min-h-0 flex-1 overflow-y-auto pb-24 overscroll-auto lg:overscroll-contain lg:pb-0">
            {form}
          </div>
          {footer}
        </section>

        {/* ── Results pane ── */}
        <section className="flex min-h-[60vh] min-w-0 flex-1 flex-col border-t lg:min-h-0 lg:border-t-0">
          {header}
          {children}
        </section>
      </div>
    </AssetShell>
  );
}

/** The results pane's title row. `meta` is the right-hand status line. */
export function ResultsPaneHeader({ meta, title }: { meta?: ReactNode; title: string }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
      <span className="text-foreground text-xs font-semibold">{title}</span>
      {meta && <span className="text-muted-foreground truncate text-[11px]">{meta}</span>}
    </div>
  );
}

/**
 * The secondary line under a result card's prompt: when it was made, plus
 * whatever the lane knows about how. Every result entry has stored an `at`
 * timestamp since the first version and NO card ever rendered it — so a
 * gallery gave no way to tell two similar-looking images apart or order them
 * by anything but position. Parts the lane doesn't know are dropped rather
 * than rendered as blanks.
 */
export function resultMeta(at: number, detail?: string): string {
  const when = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const seconds = Math.round((at - Date.now()) / 1000);
  // Spans are the average lengths of each unit, so the running value is
  // fractional; RelativeTimeFormat does NOT round (it renders "2.895 years
  // ago"), so round before handing it over.
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.348],
    ["month", 12],
    ["year", Number.POSITIVE_INFINITY],
  ];
  let value = seconds;
  for (const [unit, span] of units) {
    if (Math.abs(value) < span) {
      const stamp = when.format(Math.round(value), unit);
      return detail ? `${stamp} · ${detail}` : stamp;
    }
    value /= span;
  }
  const stamp = when.format(Math.round(value), "year");
  return detail ? `${stamp} · ${detail}` : stamp;
}

/**
 * A bounded integer with − / + buttons around a numeric input. The bare
 * `<input type="number">` this replaces gave no affordance for the bounds and
 * made the common case (nudge by one) a scroll-wheel or arrow-key affair.
 * The buttons are the fast path; typing is still allowed, and the value is
 * clamped to `[min, max]` on every change.
 */
export function NumberStepper({
  decrementLabel,
  id,
  incrementLabel,
  max,
  min,
  onChange,
  value,
}: {
  decrementLabel: string;
  id: string;
  incrementLabel: string;
  max: number;
  min: number;
  onChange: (value: number) => void;
  value: number;
}) {
  const { t } = useI18n();
  return (
    <div className="flex h-9 items-center rounded-[8px] border">
      <Button
        aria-label={decrementLabel}
        className="text-muted-foreground hover:text-foreground h-full w-8 shrink-0 rounded-l-[8px]"
        disabled={value <= min}
        onClick={() => onChange(Math.max(min, value - 1))}
        size="icon"
        variant="ghost"
      >
        <Icon className="size-3.5" name="minus" />
      </Button>
      <Input
        aria-label={t("generator.valueLabel")}
        className="h-full min-w-0 flex-1 border-0 bg-transparent px-1 text-center text-sm shadow-none focus-visible:ring-0"
        id={id}
        inputMode="numeric"
        max={max}
        min={min}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Number(e.target.value) || min)))}
        type="number"
        value={value}
      />
      <Button
        aria-label={incrementLabel}
        className="text-muted-foreground hover:text-foreground h-full w-8 shrink-0 rounded-r-[8px]"
        disabled={value >= max}
        onClick={() => onChange(Math.min(max, value + 1))}
        size="icon"
        variant="ghost"
      >
        <Icon className="size-3.5" name="plus" />
      </Button>
    </div>
  );
}

/**
 * Join a card's detail chips (duration, resolution, model…) with the dot
 * separator, dropping the ones the run didn't carry. Stored requests vary by
 * lane and by version, so every field is optional by construction.
 */
export function detailLine(...parts: Array<string | number | undefined | null | false>): string | undefined {
  const kept = parts.filter((p): p is string | number => p !== undefined && p !== null && p !== false && p !== "");
  return kept.length > 0 ? kept.join(" · ") : undefined;
}

/** The shared "nothing here yet" state for an empty results pane. */
export function EmptyResults({ description, title }: { description: string; title: string }) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center">
      <Icon className="size-16 stroke-1" name="inbox" />
      <p className="text-foreground text-sm font-medium">{title}</p>
      <p className="max-w-56 text-xs">{description}</p>
    </div>
  );
}

/** A lane's in-flight workflow: live status, elapsed clock, queue position,
 *  server error, the raw workflow id and a Cancel button. Pinned above the
 *  results grid. */
export function JobCard({
  cancelLabel,
  elapsed,
  error,
  onCancel,
  queuePosition,
  statusLabel,
  workflowId,
}: {
  cancelLabel: string;
  /** Seconds since submit. */
  elapsed: number;
  error?: string | null;
  onCancel: () => void;
  /** Null when the orchestrator reports no position. */
  queuePosition?: number | null;
  statusLabel: string;
  workflowId: string;
}) {
  const { t } = useI18n();
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  const clock = `${minutes}:${String(seconds).padStart(2, "0")}`;
  return (
    <div
      aria-live="polite"
      className="flex flex-col gap-1.5 rounded-[10px] border border-primary/40 bg-secondary/60 p-3"
    >
      <div className="flex items-center gap-2 text-sm font-medium">
        <Spinner className="size-4" />
        {statusLabel}
        <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">{clock}</span>
      </div>
      {queuePosition != null && queuePosition > 0 && (
        <p className="text-muted-foreground text-xs">{t("generator.queuePosition", { position: queuePosition })}</p>
      )}
      {error && <p className="text-destructive text-xs">{error}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground/60 truncate font-mono text-[10px]">{workflowId}</p>
        <Button className="h-7 shrink-0 rounded-[6px] px-2 text-xs" onClick={onCancel} size="sm" variant="secondary">
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}
