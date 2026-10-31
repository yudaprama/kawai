import { Icon } from "@/components/shared/icon";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FileIcon } from "@/components/shared/file-icon";
import { EdgeFades, useXOverflow } from "@/components/shared/edge-fades";
import { MarkdownWithCharts } from "@/features/workbench/components/markdown-with-charts";
import { YoutubeEmbed, type YoutubeEmbedHandle } from "@/features/workbench/components/youtube-embed";
import { DeckPreview } from "@/features/workbench/components/deck-preview";
import { slugify } from "@/lib/utils";
import {
  call,
  errText,
  type DeliverableTranslationMeta,
  type DeliverableTranslations,
  type OfficeFileSummary,
} from "@/lib/api";
import { emitOpenPreview } from "@/lib/preview-bridge";
import {
  AgentReportsSwitcher,
  ScrollToBottomButton,
  StepReportBody,
} from "@/features/workbench/components/shared-canvas";
import {
  agentName,
  DELIVERABLE_STEP_ID,
  DELIVERABLE_TOOL,
  isDeliverableStep,
  type WorkbenchController,
} from "@/features/workbench/hooks/use-workbench";
import { fmtDateUS } from "@/features/workbench/components/tool-views/format";
import type { WorkbenchRun } from "@/features/workbench/hooks/use-workbench";
import type { SupervisorStep } from "@/features/chat/hooks/use-supervisor-plan";
import { fmtDuration, ReviewActions, settledCount } from "./progress-rail";
import { auditRunStep, BinanceAuditOffer } from "./binance-audit-offer";
import { CryptoScreenerOffer, screenerRunStepIds } from "./crypto-screener-offer";

/** The run's deck artifact, if any — the deliverable hero. Set DIRECTLY from
 *  the planCompleted callback / restored record (workbench.deck) — not via
 *  the reducer — so the hero cannot be lost to a state-chain regression. */

// ── Canvas view ───────────────────────────────────────────────────────────────

/** Shared empty-state line — the canvas (idle viewer) and the page's
 *  zero-runs branch render the same words, so the hint reads as one system. */
export const EMPTY_RUNS_HINT = "State a goal in the composer to start a run.";

/** Canvas view: which run's which document is on the right pane. Null only
 *  before the first run produces anything. doc = "final" | stepId. */
export interface CanvasView {
  runId: string;
  doc: string;
}

/** Level-1 switcher in the canvas header: pick which RUN is shown. */
export function RunSwitcher({
  activeRunId,
  onPick,
  runs,
  view,
}: {
  activeRunId: string | null;
  onPick: (runId: string) => void;
  runs: WorkbenchRun[];
  view: CanvasView | null;
}) {
  // Single-row scroll instead of unbounded wrapping — a 10-run session must
  // not eat the canvas with chip rows. The right-edge fade appears only when
  // the strip actually overflows (ResizeObserver, so window resizes track).
  const { ref: scrollerRef, showStart, showEnd } = useXOverflow<HTMLDivElement>(runs.length);
  if (runs.length === 0) return null;
  const selectedId = view?.runId ?? activeRunId;
  return (
    <div className="relative">
      <div
        className="flex flex-nowrap items-center gap-1.5 overflow-x-auto py-1.5 pr-1.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        ref={scrollerRef}
      >
        {runs.map((r, i) => {
          const sel = r.id === selectedId;
          const goalLabel = r.goal.length > 28 ? `${r.goal.slice(0, 27).trimEnd()}…` : r.goal;
          return (
            <button
              aria-pressed={sel}
              className={`hit-44 inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-3 py-1.5 font-mono text-xs transition-colors ${
                sel
                  ? "border-primary bg-primary/10 text-foreground"
                  : "border-border/60 text-foreground/80 hover:border-primary/60"
              }`}
              key={r.id}
              onClick={() => onPick(r.id)}
              title={r.goal}
              type="button"
            >
              <span className="whitespace-nowrap">Run {i + 1}</span>
              {/* Goal text at lg+ only: below lg the canvas header directly
                  beneath this strip shows the FULL goal (line-clamp-2), so a
                  truncated copy inside the chip just burns the row's width. */}
              {goalLabel !== "" && <span className="hidden max-w-[12rem] truncate lg:inline">{goalLabel}</span>}
              {r.status === "running" ? (
                <Icon name="loader-circle" className="text-primary size-3 shrink-0 animate-spin" />
              ) : r.status === "completed" ? (
                <Icon name="check-circle-2" className="text-success size-3 shrink-0" />
              ) : (
                <Icon name="circle-x" className="text-destructive size-3 shrink-0" />
              )}
            </button>
          );
        })}
      </div>
      <EdgeFades showEnd={showEnd} showStart={showStart} />
    </div>
  );
}

/** Target languages for the deliverable translator. `value` is the language
 *  name the prompt carries (the model resolves it), `label` is the native
 *  display in the picker — a fixed menu, hardcoded like every other constant. */
const TRANSLATE_LANGUAGES = [
  { value: "English", label: "English" },
  { value: "Bahasa Indonesia", label: "Bahasa Indonesia" },
  { value: "Japanese", label: "日本語" },
  { value: "Korean", label: "한국어" },
  { value: "Simplified Chinese", label: "中文 (Simplified)" },
  { value: "Spanish", label: "Español" },
  { value: "French", label: "Français" },
  { value: "German", label: "Deutsch" },
  { value: "Portuguese", label: "Português" },
  { value: "Russian", label: "Русский" },
  { value: "Arabic", label: "العربية" },
  { value: "Hindi", label: "हिन्दी" },
];

/** Display label for a language value (unknown/custom values pass through). */
const translateLabel = (value: string) => TRANSLATE_LANGUAGES.find((l) => l.value === value)?.label ?? value;

/** Deliverable body + its toolbar: a compact translate picker (translates on
 *  language selection), the Copy/PDF/DOCX actions at the toolbar's right
 *  edge, and the body (original or a translated copy). Shared by the live
 *  canvas and PastRunCanvas so the translate feature exists in exactly one
 *  place. The original markdown stays the source of truth — a translation is
 *  a view overlay (re-translating always runs from the original; "Show
 *  original" drops it), and Copy/Export follow whatever is on screen. */
function DeliverableBody({
  goal,
  markdown,
  sessionId,
  showExport,
  videoId,
}: {
  goal: string;
  markdown: string;
  /** Observability conversation key — groups this one-shot with the
   *  session's other generations when known (past runs may not carry one). */
  sessionId?: number | null;
  /** Offer the Copy/Export row (a completed run only). */
  showExport: boolean;
  /** Source video of a YouTube Video Analysis run — mounts the player above the
   *  body and turns the deliverable's `mm:ss` timestamps into seeks. */
  videoId?: string | null;
}) {
  const playerRef = useRef<YoutubeEmbedHandle>(null);
  const [language, setLanguage] = useState<string>(TRANSLATE_LANGUAGES[0].value);
  /** The deliverable's own detected language (backend whatlang) — the
   *  picker defaults to it, so the trigger names what's actually on screen
   *  instead of a hardcoded English. Null = uncertain/out of menu. */
  const [sourceLanguage, setSourceLanguage] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [translated, setTranslated] = useState<{ language: string; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Server-side saved translations for THIS exact text (content-hash keyed):
  // chips restore one instantly from storage — no LLM call on reopen.
  const [saved, setSaved] = useState<DeliverableTranslationMeta[]>([]);

  // A NEW deliverable must never inherit the previous one's overlay, and a
  // translation response landing after the deliverable changed must be
  // dropped — sourceRef holds the markdown the in-flight call started from.
  const sourceRef = useRef(markdown);
  useEffect(() => {
    sourceRef.current = markdown;
    setTranslated(null);
    setError(null);
    setSaved([]);
    // Saved chips are progressive enhancement: a failed list just renders none.
    void (async () => {
      try {
        const res = await call<DeliverableTranslations>("deliverable_translations", { markdown });
        if (sourceRef.current === markdown) {
          setSaved(res.translations);
          setSourceLanguage(res.sourceLanguage);
          setLanguage(res.sourceLanguage ?? TRANSLATE_LANGUAGES[0].value);
        }
      } catch (err) {
        console.error("[workbench] deliverable_translations:", errText(err));
      }
    })();
  }, [markdown]);

  /** Translate (button) OR restore a saved chip — same op either way: a chip's
   *  language already exists server-side, so it returns the stored body with
   *  zero LLM calls. */
  const runTranslate = async (lang: string) => {
    if (translating) return;
    const source = markdown;
    setTranslating(true);
    setError(null);
    try {
      const text = await call<string>("translate_deliverable", {
        markdown: source,
        language: lang,
        sessionId: sessionId ?? null,
      });
      if (sourceRef.current === source) {
        setTranslated({ language: lang, text });
        // Mirror the write the op just persisted (server list is authoritative
        // on next mount; this keeps chips complete within the session).
        setSaved((prev) =>
          prev.some((t) => t.language === lang)
            ? prev
            : [{ language: lang, createdAt: Math.floor(Date.now() / 1000) }, ...prev],
        );
      }
    } catch (err) {
      console.error("[workbench] translate_deliverable:", errText(err));
      if (sourceRef.current === source) setError(errText(err));
    } finally {
      setTranslating(false);
    }
  };

  /** One language pick, both toolbars (desktop Select + mobile ⋯ menu).
   *  The content's own language is already what's on screen — picking it
   *  shows the original instead of an identity LLM round trip. */
  const pickLanguage = (lang: string) => {
    setLanguage(lang);
    if (lang === sourceLanguage) {
      setTranslated(null);
      return;
    }
    void runTranslate(lang);
  };

  // Copy/Export state — folded in from the old sticky export bar (the bar
  // permanently covered the bottom of a phone screen; the actions now live
  // in the toolbar at the top of the body). Copy/Export follow whatever is
  // on screen: `shown` is passed, so a translated view exports translated.
  const [exporting, setExporting] = useState<"pdf" | "docx" | null>(null);
  const [exported, setExported] = useState<{ id: string; name: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const copyMarkdown = async (markdown: string) => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
      setExportError("Copy failed — clipboard unavailable");
    }
  };

  const runExport = async (format: "pdf" | "docx", markdown: string, goal: string) => {
    if (exporting) return;
    setExporting(format);
    setExported(null);
    setExportError(null);
    const slug = slugify(goal, "deliverable");
    try {
      const file = await call<OfficeFileSummary>("export_deliverable", {
        markdown,
        filename: `${slug}.${format}`,
      });
      setExported({ id: file.id, name: file.originalName });
      setExportError(null);
    } catch (err) {
      console.error("[workbench] export_deliverable:", errText(err));
      setExported(null);
      setExportError(errText(err));
    } finally {
      setExporting(null);
    }
  };

  const shown = translated?.text ?? markdown;
  const shownLanguage = translated == null ? null : translateLabel(translated.language);

  return (
    <>
      {videoId != null && (
        <div className="max-w-2xl">
          <YoutubeEmbed ref={playerRef} videoId={videoId} title={goal} />
        </div>
      )}
      {/* Desktop: one toolbar row, two groups — translate is a single picker
       * that translates on selection; Copy/PDF/DOCX sit at the right edge
       * and the outcome renders as a plain line. Mobile hides this row: the
       * same actions collapse into the ⋯ menu below (on a phone the document,
       * not its controls, is the content). */}
      <div className="hidden flex-wrap items-center justify-between gap-x-3 gap-y-1.5 lg:flex">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Select disabled={translating} onValueChange={pickLanguage} value={language}>
            <SelectTrigger aria-label="Translate the deliverable" className="w-auto gap-1.5" size="sm">
              {translating ? (
                <Icon name="loader-circle" className="size-3 animate-spin" />
              ) : (
                <Icon name="languages" className="size-3.5" />
              )}
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TRANSLATE_LANGUAGES.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {shownLanguage != null && (
            <>
              {/* Live region: the swap to the translated body is otherwise
                  silent for screen readers (the toolbar is where it's announced
                  — the body swap happens below the fold on long documents). */}
              <span aria-live="polite" className="text-muted-foreground font-mono text-[0.6875rem]">
                Showing {shownLanguage}
              </span>
              <button
                className="hit-44 text-muted-foreground hover:text-primary font-mono text-[0.6875rem] hover:underline"
                onClick={() => setTranslated(null)}
                title="Back to the original deliverable"
                type="button"
              >
                Show original
              </button>
            </>
          )}
          {saved.length > 0 && (
            <span className="text-muted-foreground flex items-center gap-1 font-mono text-[0.6875rem]">
              Saved:
              {saved
                .filter((t) => t.language !== translated?.language)
                .map((t) => (
                  <button
                    key={t.language}
                    className="hit-44 border-border text-muted-foreground hover:text-primary rounded-full border px-2 py-0.5 text-[0.6875rem] hover:border-current disabled:opacity-50"
                    disabled={translating}
                    onClick={() => void runTranslate(t.language)}
                    title={`Show the saved ${translateLabel(t.language)} translation`}
                    type="button"
                  >
                    {translateLabel(t.language)}
                  </button>
                ))}
            </span>
          )}
        </div>
        {showExport && (
          <div className="flex shrink-0 items-center gap-1">
            <Button
              aria-label="Copy the deliverable as markdown"
              className="hit-44 text-muted-foreground hover:text-foreground size-8 [&_svg]:size-3.5"
              disabled={copied}
              onClick={() => void copyMarkdown(shown)}
              size="icon"
              title="Copy markdown"
              variant="ghost"
            >
              <Icon name={copied ? "check" : "copy"} />
            </Button>
            <Button
              disabled={exporting != null}
              onClick={() => void runExport("pdf", shown, goal)}
              size="sm"
              variant="outline"
            >
              {exporting === "pdf" ? (
                <Icon name="loader-circle" className="size-3 animate-spin" />
              ) : (
                <FileIcon className="size-3" name="export.pdf" />
              )}
              PDF
            </Button>
            <Button
              disabled={exporting != null}
              onClick={() => void runExport("docx", shown, goal)}
              size="sm"
              variant="outline"
            >
              {exporting === "docx" ? (
                <Icon name="loader-circle" className="size-3 animate-spin" />
              ) : (
                <FileIcon className="size-3" name="export.docx" />
              )}
              DOCX
            </Button>
          </div>
        )}
      </div>
      {/* ⋯ menu through <lg (phones AND tablets): the desktop toolbar's actions
          collapse into one menu — the document, not its controls, is the
          content — and the full toolbar would scroll under the sticky report
          switcher, clipping its buttons mid-scroll. The menu keeps every
          action reachable at any scroll position. */}
      <div className="flex items-center justify-end gap-2 lg:hidden">
        {shownLanguage != null && (
          <span className="text-muted-foreground flex min-w-0 items-center gap-2 font-mono text-[0.6875rem]">
            <span className="truncate">Showing {shownLanguage}</span>
            <button
              className="hit-44 hover:text-primary shrink-0 hover:underline"
              onClick={() => setTranslated(null)}
              title="Back to the original deliverable"
              type="button"
            >
              Show original
            </button>
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              aria-label="Deliverable actions"
              className="hit-44 text-muted-foreground hover:text-foreground size-8 shrink-0 [&_svg]:size-3.5"
              size="icon"
              variant="ghost"
            >
              {translating ? <Icon name="loader-circle" className="size-3.5 animate-spin" /> : <Icon name="ellipsis" />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Icon name="languages" className="size-3.5" />
                Translate
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="max-h-72 overflow-y-auto">
                {TRANSLATE_LANGUAGES.map((l) => (
                  <DropdownMenuItem key={l.value} disabled={translating} onSelect={() => pickLanguage(l.value)}>
                    {l.label}
                    {saved.some((t) => t.language === l.value) && (
                      <span className="text-muted-foreground font-mono text-[0.625rem]">· saved</span>
                    )}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            {showExport && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void copyMarkdown(shown)}>
                  <Icon name={copied ? "check" : "copy"} className="size-3.5" />
                  Copy markdown
                </DropdownMenuItem>
                <DropdownMenuItem disabled={exporting != null} onSelect={() => void runExport("pdf", shown, goal)}>
                  <FileIcon className="size-3" name="export.pdf" />
                  Export PDF
                </DropdownMenuItem>
                <DropdownMenuItem disabled={exporting != null} onSelect={() => void runExport("docx", shown, goal)}>
                  <FileIcon className="size-3" name="export.docx" />
                  Export DOCX
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {/* Copy/export/translate feedback — an ordinary line, not a sticky
          band. Export opens the office-store file in the app-level preview
          dialog. Shared by both toolbars so the mobile menu surfaces the
          same outcomes. */}
      {(copied || exported != null || exportError != null || error != null) && (
        <div aria-live="polite" className="text-muted-foreground font-mono text-[0.6875rem]">
          {exportError != null ? (
            <span className="text-destructive">Export failed: {exportError}</span>
          ) : error != null ? (
            <span className="text-destructive">Translate failed: {error}</span>
          ) : exported != null ? (
            <button
              className="hit-44 text-success hover:text-primary inline-flex items-center gap-1 px-1 hover:underline"
              onClick={() => emitOpenPreview(exported.id, exported.name)}
              title="Open the exported file"
              type="button"
            >
              Saved as {exported.name}
              <Icon name="external-link" className="size-3" />
            </button>
          ) : (
            "Copied to clipboard"
          )}
        </div>
      )}

      {/* Generated text sits flat on the canvas background — no card border
          or tinted surface (the ChatGPT/Gemini reading pattern). */}
      {/* Mobile type scale: 15px base + table cells on <lg — the 14px canvas
          default reads dense on a phone; lg+ keeps the desktop sizes. */}
      <div
        aria-busy={translating}
        className={`max-lg:text-[0.9375rem] [&_[data-streamdown=table-cell]]:max-lg:px-3 [&_[data-streamdown=table-cell]]:max-lg:text-[0.9375rem] [&_[data-streamdown=table-header-cell]]:max-lg:px-3 [&_[data-streamdown=table-header-cell]]:max-lg:text-[0.9375rem] ${
          translating ? "opacity-60 transition-opacity" : ""
        }`}
      >
        <MarkdownWithCharts videoId={videoId} onSeek={(s) => playerRef.current?.seek(s)}>
          {shown}
        </MarkdownWithCharts>
      </div>
    </>
  );
}

/** Canvas content for a PAST run: its deliverable or one of its step reports
 *  (fetched on demand from supervisor_step_results via the run's planKey).
 *  Same shape as the active-run canvas: header, document, doc switcher. */
/** Per-container scroll memory keyed by `key`: switching keys saves the old
 *  container's scrollTop and restores the new key's last position (0 for a
 *  key never visited). Reading a long deliverable survives a peek at a step
 *  report and back. Returns the ref to attach to the scrolling container. */
function useScrollMemory(key: string) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrollTops = useRef<Map<string, number>>(new Map());
  const prevKeyRef = useRef<string | null>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el == null) return;
    const prevKey = prevKeyRef.current;
    if (prevKey !== key) {
      if (prevKey != null) scrollTops.current.set(prevKey, el.scrollTop);
      el.scrollTop = scrollTops.current.get(key) ?? 0;
      prevKeyRef.current = key;
    }
  }, [key]);
  return scrollRef;
}

export function PastRunCanvas({
  loadFullOutput,
  run,
  doc,
  sessionId,
  onBuildOn,
  onPickDoc,
  onAsk,
  onScrollShift,
}: {
  loadFullOutput: (stepId: string, planKey?: string) => Promise<string | null>;
  run: WorkbenchRun;
  doc: string;
  /** Session this run belongs to — observability/lifecycle key for the
   *  translate op so saved translations follow the session. */
  sessionId?: number | null;
  /** "Build on this": arm this run's deliverable as the follow-up quote
   *  target. Only offered when the run has a quotable deliverable. */
  onBuildOn?: (run: WorkbenchRun) => void;
  /** Switch the canvas to one of this run's documents (deliverable or a
   *  step report) — wired by the page to its canvas-view navigation. */
  onPickDoc?: (doc: string) => void;
  /** Ask-about-result for this run's step reports (its own planKey). */
  onAsk?: (stepId: string, question: string, planKeyOverride?: string) => Promise<string | null>;
  /** Phone composer signal — same contract as the live viewer's. */
  onScrollShift?: (dir: "down" | "up") => void;
  discardArmed: boolean;
  setDiscardArmed: (v: boolean) => void;
}) {
  const isDeliverable = doc === "final";
  /** The audit step when this run IS a futures risk audit — keys the
   * post-report placement offer, and carries the venue whose orders it places. */
  const pastAuditStep = auditRunStep(run.steps);
  /** EVERY screener step, not just the first: the pipeline emits one step per
   * screen and each carries its own hits, so reading one showed a single
   * screen's slice of the scan. Renders only for a `usdm` run (the parser
   * returns null for spot, which has no futures trade client). */
  const pastScreenerStepIds = screenerRunStepIds(run.steps);
  /** Header label: the step's task (agentName), or the tool — never the raw
   *  step id. Same derivation the active canvas uses. */
  const docStep = (run.steps ?? []).find((s) => s.stepId === doc);
  const docStepLabel = (docStep?.task || docStep?.tool || doc).trim();
  const goalLabel = run.goal.length > 48 ? `${run.goal.slice(0, 47).trimEnd()}…` : run.goal;
  const deliverableBody = run.outputFull ?? (run.outputPreview ? `${run.outputPreview}…` : null);
  const stepTool = run.steps?.find((s) => s.stepId === doc)?.tool ?? "";
  // Scroll memory (per run — the container key is the run id): same doc
  // round-trip keeps the reading position, an unvisited doc opens at the top.
  const scrollRef = useScrollMemory(doc);
  // Scroll-direction tracker for the phone composer signal (see onScrollShift).
  const lastScrollTop = useRef(0);
  const [errorCopied, setErrorCopied] = useState(false);
  return (
    <div className="relative h-full">
      <div
        className="h-full overflow-y-auto"
        key={run.id}
        onScroll={(e) => {
          const el = e.currentTarget;
          const prev = lastScrollTop.current;
          const at = el.scrollTop;
          lastScrollTop.current = at;
          if (onScrollShift == null) return;
          if (Math.abs(at - prev) > 200) return;
          if (at <= 4 || at + el.clientHeight >= el.scrollHeight - 4) onScrollShift("up");
          else if (at > prev + 4) onScrollShift("down");
          else if (at < prev - 4) onScrollShift("up");
        }}
        ref={scrollRef}
      >
        <div className="mx-auto max-w-4xl space-y-4 px-4 py-6 sm:space-y-6 sm:p-6">
          <div>
            <h3 className="text-foreground inline-flex items-center gap-2 text-lg sm:text-xl font-semibold">
              <Icon name="zap" className="text-primary size-5" />
              {goalLabel || "Working…"}
              {!isDeliverable && docStep != null && (
                <span className="text-muted-foreground text-sm font-normal">— {docStepLabel} report</span>
              )}
            </h3>
            <div className="text-muted-foreground mt-1 flex items-center gap-3 font-mono text-sm">
              <span className="hidden sm:inline">
                {fmtDateUS(run.startedAt)}
                {run.stepsTotal != null && ` · ${run.stepsDone ?? 0}/${run.stepsTotal} steps`}
              </span>
              {onBuildOn != null && run.status === "completed" && run.outputFull != null && run.planKey != null && (
                <button
                  className="hit-44 hover:text-primary inline-flex items-center gap-1 px-1 font-mono text-[0.6875rem] hover:underline"
                  onClick={() => onBuildOn(run)}
                  title={`Arm “${goalLabel}” as the follow-up context`}
                  type="button"
                >
                  <Icon name="corner-down-right" className="size-3" />
                  build on this
                </button>
              )}
            </div>
          </div>

          {/* Sticky document nav — the deliverable ↔ report picker stays
            reachable while reading instead of sitting below a long document.
            The rail's "see report" links stay a second path. */}
          {onPickDoc != null && (run.steps ?? []).length > 0 && (
            <div className="sticky top-0 z-10 -mx-4 border-b border-border/60 bg-background px-4 py-2 sm:-mx-6">
              <AgentReportsSwitcher
                activeDoc={doc}
                hasDeliverable={run.status === "running" || (run.status === "completed" && run.outputFull != null)}
                onPickDoc={onPickDoc}
                reports={(run.steps ?? [])
                  .filter(
                    (s) =>
                      // Record steps are the persisted shape (optional fields) —
                      // match the reserved writer step by id/tool instead of
                      // isDeliverableStep (which needs the live SupervisorStep).
                      s.stepId !== DELIVERABLE_STEP_ID &&
                      s.tool !== DELIVERABLE_TOOL &&
                      (s.state === "completed" || s.state === "failed") &&
                      (s.output != null || s.error != null),
                  )
                  .map((s) => ({ label: (s.task || s.tool || s.stepId).trim(), stepId: s.stepId }))}
              />
            </div>
          )}

          {isDeliverable ? (
            run.status === "failed" && run.error != null ? (
              // Failure visibility: a failed run never produced a deliverable —
              // and its outputPreview is just the error's first 200 chars, which
              // must not render AS the deliverable body.
              <div className="border-destructive/40 bg-card rounded-lg border p-6">
                <div className="text-destructive font-mono text-xs font-bold tracking-wider uppercase">Run failed</div>
                <p className="text-muted-foreground mt-2 font-mono text-xs leading-relaxed break-words">{run.error}</p>
                {/* A past run can't resume — the copy gives the error a path
                  out of the app (bug report) instead of a dead end. */}
                <Button
                  className="mt-3"
                  onClick={() => {
                    void navigator.clipboard.writeText(run.error ?? "").then(
                      () => setErrorCopied(true),
                      () => {},
                    );
                  }}
                  size="sm"
                  variant="outline"
                >
                  <Icon name={errorCopied ? "check" : "copy"} className="size-3" />
                  {errorCopied ? "Copied" : "Copy error"}
                </Button>
              </div>
            ) : deliverableBody ? (
              <DeliverableBody
                goal={run.goal}
                markdown={deliverableBody}
                sessionId={sessionId}
                showExport={run.status === "completed" && run.outputFull != null}
                videoId={run.videoId}
              />
            ) : (
              <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center font-mono text-sm">
                No deliverable was produced.
              </div>
            )
          ) : docStep?.state === "failed" && docStep.error != null && docStep.output == null ? (
            <div className="border-destructive/40 bg-card rounded-lg border p-4">
              <div className="text-destructive font-mono text-xs font-bold tracking-wider uppercase">Step failed</div>
              <p className="text-muted-foreground mt-1.5 font-mono text-xs leading-relaxed break-words">
                {docStep.error}
              </p>
            </div>
          ) : (
            <StepReportBody
              fetcher={loadFullOutput}
              // Always fetch the full body — same as the live canvas, so a
              // restored report matches what the run showed. Runs with a
              // planKey read their own plan's rows; legacy records without one
              // pass "" which hits supervisor::step_output's session-scope
              // fallback (newest rows for that step id, still user-scoped —
              // a same-id step from a NEWER run can win). On failure the
              // ≤2000-char record embed stays visible.
              needsFetch
              planKey={run.planKey ?? ""}
              previewOutput={docStep?.output ?? ""}
              stepId={doc}
              tool={stepTool}
              onAsk={onAsk ? (stepId, question) => onAsk(stepId, question, run.planKey ?? "") : undefined}
            />
          )}

          {/* Post-audit placement offer: the audit proposed, the user approves
            here. Renders under the report of a COMPLETED audit run only. */}
          {isDeliverable && run.status === "completed" && pastAuditStep != null && (
            <BinanceAuditOffer
              fetcher={loadFullOutput}
              planKey={run.planKey ?? ""}
              sessionId={sessionId}
              stepId={pastAuditStep.stepId}
              venue={pastAuditStep.venue}
            />
          )}
          {/* Post-screener entry offer: the run's own hits, opened only where
            the user approves. Sits beside the audit's offer — a run is one
            or the other, never both. */}
          {isDeliverable && run.status === "completed" && pastAuditStep == null && pastScreenerStepIds.length > 0 && (
            <CryptoScreenerOffer fetcher={loadFullOutput} planKey={run.planKey ?? ""} stepIds={pastScreenerStepIds} />
          )}
        </div>
      </div>
      <ScrollToBottomButton containerRef={scrollRef} watchKey={run.id} />
    </div>
  );
}

// ── In-flight status strip ───────────────────────────────────────────────────

/** Live status card on the FINAL view while a run is in flight — the canvas
 *  never sits blank between submit and the deliverable landing. Covers the
 *  planning window (unseeded), step execution, the deliverable writer (whose
 *  output only lands at planCompleted), approval gates, and stop. The rich
 *  planning telemetry stays in the rail; this is the compact canvas mirror.
 *  Elapsed clocks tick via the parent's per-second re-render. */
function RunStatusStrip({
  startedAt,
  unseeded,
  workbench,
  discardArmed,
  setDiscardArmed,
}: {
  /** Current run's submit time — the elapsed clock source while unseeded
   *  (planStartedAt still belongs to the previous run then). */
  startedAt: number | null;
  unseeded: boolean;
  workbench: WorkbenchController;
  discardArmed: boolean;
  setDiscardArmed: (v: boolean) => void;
}) {
  const { supervisor } = workbench;

  // Approval gate on the canvas (DESIGN: "the confirmation card appears in
  // the center pane") — the run is paused; both mounts act on the same
  // supervisor.approve/reject and disappear together once answered.
  if (supervisor.status === "awaitingConfirmation" && supervisor.pendingConfirmation) {
    return (
      <div className="border-primary/30 bg-card space-y-3 rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs font-bold tracking-wider uppercase">
          <Icon name="shield-alert" className="text-primary size-4" />
          Approval required
        </div>
        <p className="text-foreground/90 font-mono text-sm leading-relaxed break-words">
          {supervisor.pendingConfirmation.description || supervisor.pendingConfirmation.task}
        </p>
        <div className="flex gap-2">
          <Button onClick={workbench.supervisor.approve} size="sm">
            <Icon name="play" className="size-3" />
            Approve
          </Button>
          <Button onClick={workbench.supervisor.reject} size="sm" variant="outline">
            Deny
          </Button>
        </div>
      </div>
    );
  }

  // Plan awaiting review: the full review card (summary + step list) lives in
  // the rail (mobile: the drawer auto-opens) — the canvas mirrors its ACTIONS
  // so the gate is answerable from whichever pane the user is reading.
  if (unseeded && supervisor.status === "reviewing") {
    const review = supervisor.review;
    const overview = review?.summary?.overview ?? supervisor.summary?.overview ?? null;
    return (
      <div className="border-primary/30 bg-card space-y-3 rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs font-bold tracking-wider uppercase">
          <Icon name="clipboard-check" className="text-primary size-4" />
          Plan ready for review
        </div>
        {overview != null && <p className="text-foreground/90 text-sm leading-relaxed">{overview}</p>}
        <p className="text-muted-foreground font-mono text-xs">
          {review != null ? `${review.steps.length} steps planned` : "Plan written"} — run it here, or discard to plan
          again.
        </p>
        <ReviewActions supervisor={supervisor} discardArmed={discardArmed} setDiscardArmed={setDiscardArmed} />
      </div>
    );
  }

  // Planning window (unseeded): the supervisor steps/goal still belong to the
  // previous run — mirror the rail's compact planning line instead.
  if (unseeded) {
    const planning = supervisor.planning;
    const label =
      planning == null
        ? "Preparing run…"
        : planning.round === 0
          ? planning.context != null
            ? "Starting planner…"
            : "Loading context (persona · memories · skills)…"
          : `${planning.searching ? "Searching tools" : "Writing plan"} · round ${planning.round}${planning.provider ? ` · ${planning.provider}` : ""}`;
    return (
      <div className="border-border/60 bg-card space-y-2 rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs">
          <Icon name="loader-circle" className="text-primary size-3.5 animate-spin" />
          {label}
          {startedAt != null && <span className="text-muted-foreground">· {fmtDuration(startedAt)}</span>}
        </div>
        {planning?.activity && (
          <p className="text-muted-foreground line-clamp-2 pl-5.5 font-mono text-xs italic">⌁ {planning.activity}</p>
        )}
      </div>
    );
  }

  // Seeded execution window: settled-step tally + what's happening now.
  const count = `${settledCount(supervisor.steps)}/${supervisor.steps.length} steps`;
  const elapsed = supervisor.planStartedAt != null ? ` · ${fmtDuration(supervisor.planStartedAt)}` : "";

  if (supervisor.status === "stopping") {
    return (
      <div className="border-border/60 bg-card rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs">
          <Icon name="square" className="text-muted-foreground size-3.5" />
          Stopping…
          <span className="text-muted-foreground">
            · {count}
            {elapsed}
          </span>
        </div>
      </div>
    );
  }

  // Deliverable writer running: its output arrives only with planCompleted —
  // show a writing skeleton instead of a blank pane.
  if (supervisor.steps.some((s) => isDeliverableStep(s) && s.state === "running")) {
    return (
      <div className="border-primary/30 bg-card space-y-3 rounded-lg border p-6">
        <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs">
          <Icon name="loader-circle" className="text-primary size-3.5 animate-spin" />
          Writing your answer…
          <span className="text-muted-foreground">{elapsed}</span>
        </div>
        <div className="space-y-2.5 pt-1">
          <div className="h-3 w-3/4 animate-pulse rounded bg-accent" />
          <div className="h-3 w-full animate-pulse rounded bg-accent" />
          <div className="h-3 w-5/6 animate-pulse rounded bg-accent" />
          <div className="h-3 w-2/3 animate-pulse rounded bg-accent" />
        </div>
      </div>
    );
  }

  const runningStep = supervisor.steps.find((s) => s.state === "running" && !isDeliverableStep(s));
  return (
    <div className="border-border/60 bg-card rounded-lg border p-6">
      <div className="text-foreground inline-flex items-center gap-2 font-mono text-xs">
        <Icon name="loader-circle" className="text-primary size-3.5 animate-spin" />
        {runningStep != null ? `Running · ${agentName(runningStep)}` : "Working…"}
        <span className="text-muted-foreground">
          · {count}
          {elapsed}
        </span>
      </div>
    </div>
  );
}

// ── Center: deliverable viewer ──────────────────────────────────────────────

export function DeliverableViewer({
  doc,
  runIndex,
  unseeded,
  workbench,
  onPickDoc,
  onNewGoal,
  onScrollShift,
  discardArmed,
  setDiscardArmed,
}: {
  /** Pinned document: "final" | stepId. The page owns navigation policy —
   *  this component NEVER auto-jumps on its own. */
  doc: string;
  runIndex: number;
  /** True while the supervisor state still BELONGS to the previous run
   *  (new run submitted but planStarted hasn't seeded it yet) — the goal,
   *  steps, and finalOutput read from the supervisor are stale and must not
   *  render; the run record's own goal stands in for the header instead. */
  unseeded?: boolean;
  workbench: WorkbenchController;
  /** Switch the canvas document (deliverable ↔ step reports) — wired by the
   *  page to its canvas-view navigation; without it the reports grid hides. */
  onPickDoc?: (doc: string) => void;
  /** Back to the landing composer ("New goal") — offered on the failed-run
   *  card so recovery lives where the failure is read. */
  onNewGoal?: () => void;
  /** Phone composer signal: "down" while the reader scrolls deeper (the page
   *  hides the composer bar), "up" near either edge or scrolling back. */
  onScrollShift?: (dir: "down" | "up") => void;
  discardArmed: boolean;
  setDiscardArmed: (v: boolean) => void;
}) {
  const { supervisor } = workbench;
  // Header goal: the run record knows the submitted goal from the moment of
  // submit; supervisor.goal only arrives at planStarted (and is the previous
  // run's until then). No generic "Deliverable" placeholder — that read as
  // an unexplained label.
  const runGoal = (unseeded ? null : supervisor.goal) ?? workbench.runs[runIndex]?.goal ?? null;
  // Full goal in the viewer header — it has room (max-w-4xl); the 48-char cut
  // stays only in the compact report switcher.
  const headerGoal = runGoal;
  const reports = useMemo(
    () =>
      unseeded
        ? []
        : supervisor.steps.filter(
            (s) =>
              !isDeliverableStep(s) &&
              (s.state === "completed" || s.state === "failed") &&
              (s.output != null || s.error != null),
          ),
    [unseeded, supervisor.steps],
  );
  const effective = doc;
  // Scroll memory (per run): switching docs saves the old scrollTop and
  // restores the new doc's last position — a long deliverable survives a
  // peek at a step report and back.
  const scrollRef = useScrollMemory(effective);
  // Scroll-direction tracker for the phone composer signal (see onScrollShift).
  const lastScrollTop = useRef(0);
  // Step source: supervisor state for the run it currently holds; the run
  // RECORD (≤2000-char embeds + its own planKey) otherwise — a reopened
  // session's newest run renders here too, and the supervisor may be empty
  // or hold a different run's state.
  const runRecord = workbench.runs[runIndex];
  /** The audit step when the shown run IS a futures risk audit — keys the
   * post-report placement offer. Live state wins (it is authoritative for
   * the run it holds); the persisted record covers a reopened session. */
  const liveAuditStep = unseeded
    ? auditRunStep(runRecord?.steps)
    : (auditRunStep(supervisor.steps) ?? auditRunStep(runRecord?.steps));
  /** EVERY screener step — same live-then-record precedence as the audit's, so
   * a reopened session offers its hits too. All of them: the pipeline emits
   * one step per screen and each holds a different slice of the scan, so
   * merging live + persisted (deduped) is what a completed run needs. */
  const liveScreenerStepIds = unseeded
    ? screenerRunStepIds(runRecord?.steps)
    : [...new Set([...screenerRunStepIds(supervisor.steps), ...screenerRunStepIds(runRecord?.steps)])];
  const step =
    reports.find((r) => r.stepId === effective) ??
    (runRecord?.steps ?? []).find(
      (s) =>
        s.stepId === effective &&
        (s.state === "completed" || s.state === "failed") &&
        (s.output != null || s.error != null),
    ) ??
    null;
  const resolvedStep: SupervisorStep | undefined = step ? { artifacts: [], ...step } : undefined;

  // The wire preview is capped at 2000 chars. Always fetch the full body
  // from the persisted step results — the length heuristic missed truncated
  // reports (e.g. a 2000-char JSON that parses into a few items). Values are
  // `string` on success, `"failed"` after a failed fetch (stay on the
  // preview; no retry spinner). In-flight tracking lives in a ref — a state
  // flag here would re-trigger this very effect and deadlock the fetch.
  const output = resolvedStep?.output;

  const done = unseeded ? 0 : supervisor.steps.filter((s) => s.state === "completed").length;

  // In-flight strip on the final view: shown through the whole submit →
  // deliverable window (planning unseeded, execution, writer, approval gate,
  // stop) — the canvas must never sit blank in between. `unseeded` alone is
  // enough while the supervisor state belongs to the previous run; afterwards
  // the in-flight statuses qualify until the final output lands.
  const inFlightNow = ["running", "stopping", "awaitingConfirmation"].includes(supervisor.status);
  const stripVisible = effective === "final" && (unseeded === true || (inFlightNow && supervisor.finalOutput == null));
  // Per-second tick while the strip is up — silent windows (planner rounds,
  // deliverable synthesis, no-event steps) otherwise read as a frozen UI.
  // Also keeps the header's duration line moving.
  const [, setStripTick] = useState(0);
  useEffect(() => {
    if (!stripVisible) return;
    const t = setInterval(() => setStripTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [stripVisible]);
  // Screen-reader phase announcement — the text changes ONLY on coarse phase
  // transitions (never on the per-second tick or per-step churn), so the live
  // region announces once per phase instead of chattering.
  const phaseAnnouncement = !stripVisible
    ? ""
    : unseeded
      ? supervisor.status === "reviewing"
        ? "Plan ready for review"
        : "Planning your goal"
      : supervisor.status === "awaitingConfirmation"
        ? "Approval required"
        : supervisor.status === "stopping"
          ? "Stopping"
          : supervisor.steps.some((s) => isDeliverableStep(s) && s.state === "running")
            ? "Writing your answer"
            : "Running";

  return (
    <div className="relative h-full">
      <div
        className="h-full overflow-y-auto"
        key={runIndex}
        onScroll={(e) => {
          const el = e.currentTarget;
          const prev = lastScrollTop.current;
          const at = el.scrollTop;
          lastScrollTop.current = at;
          if (onScrollShift == null) return;
          // A jump is a programmatic restore (scroll memory / doc switch) —
          // resync without toggling the composer.
          if (Math.abs(at - prev) > 200) return;
          if (at <= 4 || at + el.clientHeight >= el.scrollHeight - 4) onScrollShift("up");
          else if (at > prev + 4) onScrollShift("down");
          else if (at < prev - 4) onScrollShift("up");
        }}
        ref={scrollRef}
      >
        <div aria-live="polite" className="sr-only" role="status">
          {phaseAnnouncement}
        </div>
        <div className="mx-auto max-w-4xl space-y-4 px-4 py-6 sm:space-y-6 sm:p-6">
          <div>
            <h3
              className="text-foreground flex items-start gap-2 text-lg sm:text-xl font-semibold"
              title={headerGoal ?? undefined}
            >
              <span className="line-clamp-2">{headerGoal ?? "Working…"}</span>
            </h3>
            {effective !== "final" && resolvedStep != null && (
              <div className="text-muted-foreground mt-1 font-mono text-xs">
                Agent report · {agentName(resolvedStep)}
              </div>
            )}
            {/* Desktop-only: progress + duration. On a phone the progress
              drawer and the in-flight strip carry the same facts — a second
              mono line here is reading-view noise. */}
            <div className="text-muted-foreground mt-1 hidden font-mono text-sm sm:block">
              {unseeded ? (
                supervisor.status === "reviewing" ? (
                  <>
                    plan ready
                    {runRecord?.startedAt != null && ` · ${fmtDuration(runRecord.startedAt)}`}
                  </>
                ) : (
                  <>
                    planning…
                    {runRecord?.startedAt != null && ` · ${fmtDuration(runRecord.startedAt)}`}
                  </>
                )
              ) : (
                <>
                  {done}/{supervisor.steps.length} steps
                  {supervisor.planStartedAt != null &&
                    ` · ${fmtDuration(supervisor.planStartedAt, supervisor.planCompletedAt ?? undefined)}`}
                </>
              )}
            </div>
          </div>

          {/* Sticky document nav — the deliverable ↔ report picker stays
            reachable while reading instead of sitting below a long document.
            Hidden while planning (no reports yet) and when navigation isn't
            wired; the rail's "see report" links stay a second path. */}
          {onPickDoc != null && reports.length > 0 && (
            <div className="sticky top-0 z-10 -mx-4 border-b border-border/60 bg-background px-4 py-2 sm:-mx-6">
              <AgentReportsSwitcher
                activeDoc={effective}
                hasDeliverable={effective === "final" || inFlightNow}
                onPickDoc={onPickDoc}
                reports={reports.map((r) => ({ label: agentName(r), stepId: r.stepId }))}
              />
            </div>
          )}

          {/* In-flight status strip: planning, execution, writer, approval gate,
            stop — never a blank pane between submit and the deliverable. */}
          {stripVisible && (
            <RunStatusStrip
              startedAt={runRecord?.startedAt ?? null}
              unseeded={unseeded === true}
              workbench={workbench}
              discardArmed={discardArmed}
              setDiscardArmed={setDiscardArmed}
            />
          )}

          {supervisor.status === "idle" && supervisor.planning == null && (
            <div className="text-muted-foreground rounded-lg border border-dashed p-8 text-center font-mono text-sm">
              {EMPTY_RUNS_HINT}
            </div>
          )}

          {/* Failure visibility: a failed run says WHY on the canvas — and the
            recovery actions are reachable where the failure is read, not
            only in the rail (mirrors the rail's failed-state buttons). */}
          {effective === "final" && !unseeded && supervisor.status === "failed" && supervisor.finalOutput == null && (
            <div className="border-destructive/40 bg-card rounded-lg border p-6">
              <div className="text-destructive font-mono text-xs font-bold tracking-wider uppercase">Run failed</div>
              <p className="text-muted-foreground mt-2 font-mono text-xs leading-relaxed break-words">
                {supervisor.error ?? "The run ended before a deliverable was written."}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                {supervisor.steps.some((s) => s.state === "completed") && (
                  <Button onClick={workbench.supervisor.resume} size="sm" variant="outline">
                    <Icon name="play" className="size-3" />
                    Resume
                  </Button>
                )}
                {onNewGoal != null && (
                  <Button onClick={onNewGoal} size="sm" variant="outline">
                    <Icon name="plus" className="size-3" />
                    New goal
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* Planning progress lives in the sidebar rail (PlanningStatus inside
            ProgressRail). The canvas keeps showing the previous run's content
            until the new run's first content lands (canvas policy). */}

          {/* Deck hero: on the final view AND on the deck_writer step report
            (the report the user lands on via "see report") — both otherwise
            show only the note text without the slides. */}
          {!unseeded && workbench.deck != null && (effective === "final" || effective === "__deliverable") && (
            <div className="space-y-1">
              <div className="text-muted-foreground flex items-center gap-2 font-mono text-[0.6875rem] uppercase">
                <Icon name="zap" className="size-3" /> Deck · {workbench.deck.label ?? "presentation"}
              </div>
              {/* Native slide preview — plain DOM fragments + theme CSS (a few
                  KB per slide). The full reveal.js deck opens in the browser via
                  "Open full deck" inside the preview; no iframe in the app. */}
              <DeckPreview fileId={workbench.deck.handle} />
            </div>
          )}
          {effective === "final" && !unseeded && supervisor.finalOutput != null && (
            <DeliverableBody
              goal={supervisor.goal ?? "deliverable"}
              markdown={supervisor.finalOutput}
              sessionId={workbench.sessionId}
              showExport={supervisor.status === "completed"}
              videoId={supervisor.videoId ?? runRecord?.videoId ?? null}
            />
          )}
          {/* Post-audit placement offer: the audit proposed, the user approves
            here — one click each for stops and take-profits, confirmed before
            anything is sent. Renders only under a COMPLETED audit run. */}
          {effective === "final" && !unseeded && supervisor.status === "completed" && liveAuditStep != null && (
            <BinanceAuditOffer
              fetcher={workbench.loadFullOutput}
              planKey={runRecord?.planKey ?? supervisor.planKey ?? ""}
              sessionId={workbench.sessionId}
              stepId={liveAuditStep.stepId}
              venue={liveAuditStep.venue}
            />
          )}
          {/* Post-screener entry offer: the run's own hits, opened only where
            the user approves. A run is an audit or a screener, never both. */}
          {effective === "final" &&
            !unseeded &&
            supervisor.status === "completed" &&
            liveAuditStep == null &&
            liveScreenerStepIds.length > 0 && (
              <CryptoScreenerOffer
                fetcher={workbench.loadFullOutput}
                planKey={runRecord?.planKey ?? supervisor.planKey ?? ""}
                stepIds={liveScreenerStepIds}
              />
            )}
          {/* Failed step with no output: show its WHY instead of an empty body
            (the rail's "see report" now opens something meaningful). */}
          {effective !== "final" &&
            resolvedStep != null &&
            resolvedStep.state === "failed" &&
            output == null &&
            resolvedStep.error != null && (
              <div className="border-destructive/40 bg-card rounded-lg border p-4">
                <div className="text-destructive font-mono text-xs font-bold tracking-wider uppercase">Step failed</div>
                <p className="text-muted-foreground mt-1.5 font-mono text-xs leading-relaxed break-words">
                  {resolvedStep.error}
                </p>
              </div>
            )}
          {effective !== "final" && resolvedStep != null && output != null && resolvedStep.tool !== "deck_writer" && (
            <StepReportBody
              fetcher={workbench.loadFullOutput}
              needsFetch
              // The shown run's OWN planKey — supervisor.planKey is the ACTIVE
              // run's key and is null/stale once the session is reopened.
              // Legacy records without a planKey pass "" (session-scope read).
              planKey={runRecord?.planKey ?? supervisor.planKey ?? ""}
              cacheKey={runRecord?.id ?? "live"}
              previewOutput={output}
              stepId={resolvedStep.stepId}
              tool={resolvedStep.tool}
              onAsk={workbench.askAboutResult}
            />
          )}
        </div>
      </div>
      <ScrollToBottomButton containerRef={scrollRef} watchKey={runIndex} />
    </div>
  );
}

// ── History strip (home state) ──────────────────────────────────────────────

export function RunHistory({
  runs,
  onReopen,
}: {
  runs: WorkbenchRun[];
  /** Open the run's deliverable in the viewer — any finished run qualifies:
   *  the canvas renders past runs from their record (PastRunCanvas), not
   *  from the single-run supervisor state. */
  onReopen?: (runId: string) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <div className="mx-auto w-full max-w-4xl space-y-2 p-6">
      <h3 className="text-muted-foreground font-mono text-xs tracking-wider uppercase">Run history</h3>
      {runs
        .slice()
        .reverse()
        .map((r) => {
          const clickable = onReopen != null && r.status !== "running";
          const RowInner = (
            <>
              <div className="min-w-0 flex-1 text-left">
                <div className="text-foreground truncate text-sm">{r.goal}</div>
                <div className="text-muted-foreground font-mono text-[0.6875rem]">
                  {fmtDateUS(r.startedAt)}
                  {r.stepsTotal != null && ` · ${r.stepsDone ?? 0}/${r.stepsTotal} steps`}
                  {/* Failed rows fall back to the plan-level error — restored
                      failed records have an empty outputPreview. */}
                  {(r.outputPreview || (r.status === "failed" ? r.error : null)) &&
                    ` · ${(r.outputPreview || r.error || "").slice(0, 60)}…`}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {clickable && (
                  <span className="text-primary font-mono text-[0.625rem] group-hover:underline">View report</span>
                )}
                {r.status === "running" ? (
                  <Icon name="loader-circle" className="text-primary size-4 animate-spin" />
                ) : r.status === "completed" ? (
                  <Icon name="check-circle-2" className="text-success size-4" />
                ) : (
                  <Icon name="circle-x" className="text-destructive size-4" />
                )}
              </div>
            </>
          );
          return clickable ? (
            <button
              className="group border-border/60 hover:border-primary/50 flex w-full items-center justify-between gap-3 rounded-lg border p-3 text-left transition-colors"
              key={r.id}
              onClick={() => onReopen(r.id)}
              title={`View report: ${r.goal}`}
              type="button"
            >
              {RowInner}
            </button>
          ) : (
            // Not reopenable while running — visibly inert so it doesn't read
            // as a broken button. A running row keeps full contrast: it's
            // live, just not clickable yet.
            <div
              className={`border-border/60 flex items-center justify-between gap-3 rounded-lg border p-3${
                r.status !== "running" ? " cursor-default opacity-60" : ""
              }`}
              key={r.id}
            >
              {RowInner}
            </div>
          );
        })}
    </div>
  );
}
