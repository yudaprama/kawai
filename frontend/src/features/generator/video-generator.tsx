import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";
import { call, errText } from "@/lib/api";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { useFilePreview } from "@/lib/preview-file";
import { useI18n } from "@/hooks/use-i18n";
import {
  DEFAULT_VIDEO_ECOSYSTEM,
  VIDEO_ECOSYSTEMS,
  type VideoEcosystemConfig,
  type VideoWorkflowId,
  videoDurationChoices,
  videoDurationRange,
  videoEcosystem,
  videoHasAudio,
  videoHasNegative,
} from "./video-ecosystems";

/** Civitai videoGen request the Rust ops accept (camelCase, flattened). */
interface VideoGenRequest {
  ecosystem: string;
  workflow: VideoWorkflowId;
  prompt: string;
  negativePrompt?: string;
  sourceImage?: string;
  endImage?: string;
  model?: string;
  mode?: string;
  fastMode?: boolean;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
  enablePromptEnhancer?: boolean;
  cfgScale?: number;
  seed?: number;
  quantity?: number;
}

interface VideoCostView {
  totalBuzz: number;
  ready: boolean;
  warnings: string[];
}

interface VideoStatusView {
  workflowId: string;
  status: string;
  queuePosition: number | null;
  video?: { videoUrl: string; thumbnailUrl?: string; width?: number; height?: number };
  error?: string;
}

interface SavedVideo {
  fileId: string;
  name: string;
  thumbnailFileId?: string;
}

interface VideoResultEntry {
  fileId: string;
  name: string;
  thumbnailFileId?: string;
  prompt: string;
  at: number;
}

/** In-flight workflow, persisted so a restart resumes polling. */
interface ActiveJob {
  workflowId: string;
  prompt: string;
  at: number;
}

const RESULTS_KEY = "kawai-generator-video-results-v1";
const JOB_KEY = "kawai-generator-video-job-v1";
const MAX_RESULTS = 30;
const STATUS_WAIT_SECS = 15;
/** Terminal-but-not-success states (lowercase wire vocabulary). */
const TERMINAL_FAILED: Record<string, true> = { failed: true, expired: true, canceled: true };

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const SEGMENTED_LIST = "inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-muted p-0.5";

function segmentClass(active: boolean): string {
  return cn(
    "flex h-7 items-center rounded-md px-3 text-xs font-medium transition-colors",
    active ? "bg-background text-foreground shadow-sm dark:bg-input/30" : "text-muted-foreground hover:text-foreground",
  );
}

/** Civitai's [media tabs …… Eco | <ecosystem>] strip — video lane active;
 *  the image tab hands control back to the image panel. */
function MediaIsland({
  ecoLabel,
  ecoOpen,
  onEcoClick,
  onSwitchToImage,
  children,
}: {
  ecoLabel: string;
  ecoOpen: boolean;
  onEcoClick: () => void;
  onSwitchToImage: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-[10px] border p-1.5">
      <div className={SEGMENTED_LIST}>
        <button className={segmentClass(false)} onClick={onSwitchToImage} title="Image" type="button">
          <Icon className="size-4" name="image" />
        </button>
        <span className={cn(segmentClass(true), "pointer-events-none")} title="Video">
          <Icon className="size-4" name="video" />
        </span>
        <span className={cn(segmentClass(false), "pointer-events-none opacity-40")} title="Music">
          <Icon className="size-4" name="music" />
        </span>
        <span className={cn(segmentClass(false), "pointer-events-none opacity-40")} title="3D">
          <Icon className="size-4" name="box" />
        </span>
      </div>
      <div className="relative">
        <button
          aria-expanded={ecoOpen}
          aria-haspopup="listbox"
          className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm font-semibold transition-colors hover:brightness-125"
          onClick={onEcoClick}
          type="button"
        >
          <span className="text-muted-foreground">Eco</span>
          <span className="bg-border h-4 w-px" />
          {ecoLabel}
          <span className={cn("text-muted-foreground flex items-center transition-transform", ecoOpen && "rotate-180")}>
            <Icon name="chevron-down" />
          </span>
        </button>
        {children}
      </div>
    </div>
  );
}

/** One saved video result: <video> card with poster, click opens preview. */
function VideoResultCard({ entry }: { entry: VideoResultEntry }) {
  const main = useFilePreview({ id: entry.fileId, name: entry.name });
  const thumb = useFilePreview(
    entry.thumbnailFileId ? { id: entry.thumbnailFileId, name: `${entry.name}-thumb.jpg` } : { id: "", name: "" },
  );
  return (
    <div className="group relative overflow-hidden rounded-[8px] border bg-secondary">
      <button
        className="block w-full"
        onClick={() => emitOpenPreview(entry.fileId, entry.name)}
        title={entry.prompt}
        type="button"
      >
        {main.isLoading ? (
          <div className="flex aspect-video items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <video
            className="aspect-video w-full bg-black object-contain"
            controls
            playsInline
            poster={thumb.data?.dataUrl}
            preload="metadata"
            src={main.data?.dataUrl}
          >
            <track kind="captions" />
          </video>
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <span className="line-clamp-1 text-[11px] text-white/90">{entry.prompt || entry.name}</span>
      </div>
    </div>
  );
}

/** In-flight progress card pinned above the results grid. */
function JobCard({ job, status, elapsed }: { job: ActiveJob; status: VideoStatusView | null; elapsed: number }) {
  const { t } = useI18n();
  const statusKey =
    status?.status === "processing"
      ? "videoGenerator.processing"
      : status?.status === "succeeded"
        ? "videoGenerator.succeeded"
        : "videoGenerator.queued";
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return (
    <div className="flex flex-col gap-1.5 rounded-[10px] border border-primary/40 bg-secondary/60 p-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Spinner className="size-4" />
        {t(statusKey)}
        <span className="text-muted-foreground ml-auto font-mono text-xs tabular-nums">
          {minutes}:{String(seconds).padStart(2, "0")}
        </span>
      </div>
      {status?.queuePosition != null && status.queuePosition > 0 && (
        <p className="text-muted-foreground text-xs">
          {t("videoGenerator.position", { position: status.queuePosition })}
        </p>
      )}
      {status?.error && <p className="text-destructive text-xs">{status.error}</p>}
      <p className="text-muted-foreground/60 truncate font-mono text-[10px]">{job.workflowId}</p>
    </div>
  );
}

export function VideoGenerator({ onBack, onSwitchToImage }: { onBack: () => void; onSwitchToImage: () => void }) {
  const { t } = useI18n();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [ecoId, setEcoId] = useState(DEFAULT_VIDEO_ECOSYSTEM);
  const eco: VideoEcosystemConfig = videoEcosystem(ecoId);
  const [modelKey, setModelKey] = useState("");
  const [workflow, setWorkflow] = useState<VideoWorkflowId>("txt2vid");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(6);
  const [resolution, setResolution] = useState<string>("");
  const [aspect, setAspect] = useState<string>("16:9");
  const [audio, setAudio] = useState(false);
  const [seed, setSeed] = useState("");
  const [ecoOpen, setEcoOpen] = useState(false);
  const [cost, setCost] = useState<VideoCostView | null>(null);
  const [costError, setCostError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<ActiveJob | null>(() => loadJson<ActiveJob | null>(JOB_KEY, null));
  const [status, setStatus] = useState<VideoStatusView | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<VideoResultEntry[]>(() => loadJson<VideoResultEntry[]>(RESULTS_KEY, []));
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    call<{ configured: boolean }>("civitai_api_key_status")
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(false));
  }, []);

  // Ecosystem/model switches reset every dependent selection to the new
  // ecosystem's first valid value (duration/resolution/aspect are wire
  // enums — a stale pick would fail the whatif).
  const durationChoices = videoDurationChoices(ecoId, modelKey);
  const durationRange = videoDurationRange(ecoId, modelKey);
  const switchEcosystem = (id: string) => {
    setEcoId(id);
    setModelKey("");
    const next = videoEcosystem(id);
    const range = videoDurationRange(id, "");
    const choices = videoDurationChoices(id, "");
    setDuration(choices ? choices[Math.floor(choices.length / 2)] : Math.round((range.min + range.max) / 2));
    setResolution(next.resolutions[0] ?? "");
    setAspect(next.aspectRatios.includes("16:9") ? "16:9" : (next.aspectRatios[0] ?? ""));
    setAudio(false);
  };

  const hasAudio = videoHasAudio(ecoId, modelKey);
  const hasNegative = videoHasNegative(ecoId, modelKey);
  const isImg2Vid = workflow === "img2vid";
  const promptEffective = isImg2Vid || prompt.trim().length > 0;

  const buildRequest = useCallback((): VideoGenRequest => {
    return {
      ecosystem: ecoId,
      workflow,
      prompt: prompt.trim(),
      negativePrompt: hasNegative && negativePrompt.trim() ? negativePrompt.trim() : undefined,
      sourceImage: isImg2Vid ? (sourceImage ?? undefined) : undefined,
      model: modelKey || undefined,
      duration,
      resolution: eco.resolutions.length > 0 ? resolution || eco.resolutions[0] : undefined,
      aspectRatio: !isImg2Vid ? aspect : undefined,
      generateAudio: hasAudio ? audio : undefined,
      seed: seed.trim() ? Number(seed) : undefined,
      quantity: 1,
    };
  }, [
    audio,
    aspect,
    duration,
    eco,
    ecoId,
    hasAudio,
    hasNegative,
    isImg2Vid,
    modelKey,
    negativePrompt,
    prompt,
    resolution,
    seed,
    workflow,
    sourceImage,
  ]);

  /** Identity-stable request snapshot — the whatif effect re-runs only when
   *  the FORM actually changes, not on unrelated renders. */
  const costRequest = useMemo(buildRequest, [buildRequest]);

  // Free whatif cost check — debounced; a failure here means submit would
  // fail too, so the footer surfaces it instead of the buzz number.
  useEffect(() => {
    if (configured !== true || !promptEffective) {
      setCost(null);
      setCostError(false);
      return;
    }
    let cancelled = false;
    setCostError(false);
    const timer = setTimeout(() => {
      call<VideoCostView>("civitai_video_cost", { req: costRequest })
        .then((c) => {
          if (!cancelled && aliveRef.current) {
            setCost(c);
            setCostError(false);
          }
        })
        .catch(() => {
          if (!cancelled && aliveRef.current) {
            setCost(null);
            setCostError(true);
          }
        });
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [costRequest, configured, promptEffective]);

  // Elapsed ticker while a job is in flight.
  useEffect(() => {
    if (!job) return;
    setElapsed(Math.floor((Date.now() - job.at) / 1000));
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - job.at) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [job]);

  // Poll loop — long-poll (waitSecs) keeps it near-live without hammering.
  useEffect(() => {
    if (!job) return;
    let cancelled = false;
    void (async () => {
      while (!cancelled) {
        try {
          const st = await call<VideoStatusView>("civitai_video_status", {
            workflowId: job.workflowId,
            waitSecs: STATUS_WAIT_SECS,
          });
          if (cancelled || !aliveRef.current) return;
          setStatus(st);
          if (st.status === "succeeded" && st.video) {
            const saved = await call<SavedVideo>("civitai_video_fetch", {
              workflowId: job.workflowId,
              videoUrl: st.video.videoUrl,
              thumbnailUrl: st.video.thumbnailUrl,
            });
            if (cancelled || !aliveRef.current) return;
            const entry: VideoResultEntry = {
              fileId: saved.fileId,
              name: saved.name,
              thumbnailFileId: saved.thumbnailFileId,
              prompt: job.prompt,
              at: Date.now(),
            };
            setResults((prev) => {
              const next = [entry, ...prev].slice(0, MAX_RESULTS);
              localStorage.setItem(RESULTS_KEY, JSON.stringify(next));
              return next;
            });
            localStorage.removeItem(JOB_KEY);
            setJob(null);
            setStatus(null);
            toast.success(t("videoGenerator.done"));
            return;
          }
          if (TERMINAL_FAILED[st.status]) {
            localStorage.removeItem(JOB_KEY);
            setJob(null);
            toast.error(`${t("videoGenerator.failedToast")}: ${st.error ?? st.status}`);
            return;
          }
        } catch (e) {
          // Transport hiccup — brief pause and keep polling; the workflow
          // keeps running server-side and the job survives restarts.
          if (cancelled || !aliveRef.current) return;
          if (Date.now() - job.at > 30 * 60 * 1000) {
            localStorage.removeItem(JOB_KEY);
            setJob(null);
            toast.error(`${t("videoGenerator.failedToast")}: ${errText(e)}`);
            return;
          }
          await delay(4000);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [job, t]);

  function pickSource(file: File | undefined) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error(t("videoGenerator.sourceTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setSourceImage(typeof reader.result === "string" ? reader.result : null);
    reader.readAsDataURL(file);
  }

  const canSubmit =
    configured === true && !submitting && !job && promptEffective && (isImg2Vid ? sourceImage != null : true);

  async function handleGenerate() {
    if (!canSubmit || !promptEffective) return;
    setSubmitting(true);
    try {
      const view = await call<{ workflowId: string }>("civitai_video_submit", {
        req: buildRequest(),
      });
      const nextJob: ActiveJob = {
        workflowId: view.workflowId,
        prompt: prompt.trim(),
        at: Date.now(),
      };
      localStorage.setItem(JOB_KEY, JSON.stringify(nextJob));
      setStatus(null);
      setJob(nextJob);
    } catch (e) {
      toast.error(`${t("videoGenerator.failedToast")}: ${errText(e)}`);
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }

  const ecoPicker = (
    <div
      className="bg-popover absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-[10px] border shadow-xl"
      role="listbox"
    >
      {VIDEO_ECOSYSTEMS.map((e) => {
        const selected = e.id === ecoId;
        return (
          <button
            aria-selected={selected}
            className={cn(
              "flex w-full items-center gap-2 p-2.5 text-left transition-colors hover:bg-accent",
              selected && "bg-accent",
            )}
            key={e.id}
            onClick={() => {
              setEcoOpen(false);
              if (!selected) switchEcosystem(e.id);
            }}
            role="option"
            type="button"
          >
            <div
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-gradient-to-br text-sm font-bold text-white",
                e.gradient,
              )}
            >
              {e.label.charAt(0)}
            </div>
            <span className="min-w-0 flex-1">
              <span className={cn("block truncate text-sm font-medium", selected && "text-primary font-semibold")}>
                {e.label}
              </span>
              <span className="text-muted-foreground block truncate text-[11px]">{e.note}</span>
            </span>
            {selected && (
              <span className="text-primary shrink-0">
                <Icon name="check" />
              </span>
            )}
          </button>
        );
      })}
    </div>
  );

  const form = (
    <div className="flex flex-col gap-3 p-3">
      <MediaIsland
        ecoLabel={eco.label}
        ecoOpen={ecoOpen}
        onEcoClick={() => setEcoOpen((v) => !v)}
        onSwitchToImage={onSwitchToImage}
      >
        {ecoPicker}
      </MediaIsland>
      {ecoOpen && <div aria-hidden className="fixed inset-0 z-20" onClick={() => setEcoOpen(false)} />}
      {configured === false && (
        <div className="bg-secondary text-muted-foreground flex items-start gap-2 rounded-[8px] border p-2.5 text-xs leading-relaxed">
          <Icon className="mt-0.5 size-4 shrink-0" name="info" />
          <span>{t("generator.keyMissingBody")}</span>
        </div>
      )}
      {configured === null && (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Spinner className="size-4" /> {t("generator.checkingKey")}
        </div>
      )}

      {/* Workflow — txt2vid / img2vid segmented chips. */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.workflow")}</Label>
        <div className="flex gap-2">
          <button
            className={cn(choiceClassShared(workflow === "txt2vid"), "flex-1")}
            onClick={() => setWorkflow("txt2vid")}
            type="button"
          >
            {t("videoGenerator.txt2vid")}
          </button>
          <button
            className={cn(choiceClassShared(workflow === "img2vid"), "flex-1")}
            onClick={() => setWorkflow("img2vid")}
            type="button"
          >
            {t("videoGenerator.img2vid")}
          </button>
        </div>
      </div>

      {/* Model chips — ecosystems with more than the default pick. */}
      {eco.models.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("generator.model")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {eco.models.map((m) => (
              <button
                className={cn(choiceClassShared(modelKey === m.key), "px-3")}
                key={m.key || "default"}
                onClick={() => setModelKey(m.key)}
                type="button"
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Prompt */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="video-prompt">
          {t("generator.prompt")}
        </Label>
        <Textarea
          className="min-h-20 rounded-[8px]"
          id="video-prompt"
          maxLength={6000}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("generator.promptPlaceholder")}
          value={prompt}
        />
      </div>

      {/* Negative prompt (kling legacy, veo3, wan). */}
      {hasNegative && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="video-negative">
            {t("generator.negativePrompt")}
          </Label>
          <Input
            className="h-8 rounded-[8px]"
            id="video-negative"
            onChange={(e) => setNegativePrompt(e.target.value)}
            value={negativePrompt}
          />
        </div>
      )}

      {/* Source frame — img2vid. */}
      {isImg2Vid && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.sourceImage")}</Label>
          {sourceImage ? (
            <div className="relative overflow-hidden rounded-[8px] border">
              <img alt="" className="max-h-40 w-full object-cover" src={sourceImage} />
              <Button
                aria-label={t("videoGenerator.clearImage")}
                className="absolute top-1.5 right-1.5 size-6"
                onClick={() => setSourceImage(null)}
                size="icon"
                variant="secondary"
              >
                <Icon className="size-3.5" name="x" />
              </Button>
            </div>
          ) : (
            <label className="text-muted-foreground flex h-20 cursor-pointer flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed text-xs transition-colors hover:text-foreground">
              <Icon className="size-5" name="image-plus" />
              {t("videoGenerator.pickImage")}
              <input
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => pickSource(e.target.files?.[0])}
                type="file"
              />
            </label>
          )}
        </div>
      )}

      {/* Duration — discrete chips or a slider (kling v3). */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="video-duration">
          {t("videoGenerator.duration", { seconds: duration })}
        </Label>
        {durationChoices ? (
          <div className="flex gap-1.5">
            {durationChoices.map((d) => (
              <button
                className={cn(choiceClassShared(duration === d), "flex-1")}
                key={d}
                onClick={() => setDuration(d)}
                type="button"
              >
                {d}s
              </button>
            ))}
          </div>
        ) : (
          <Slider
            id="video-duration"
            max={durationRange.max}
            min={durationRange.min}
            onValueChange={(v) => setDuration(v[0])}
            step={1}
            value={[duration]}
          >
            <SliderTrack>
              <SliderRange />
            </SliderTrack>
            <SliderThumb aria-label={t("videoGenerator.duration", { seconds: duration })} />
          </Slider>
        )}
      </div>

      {/* Resolution — engines that take one (seedance/wan/minimax-pinned). */}
      {eco.resolutions.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.resolution")}</Label>
          <div className="flex gap-1.5">
            {eco.resolutions.map((r) => (
              <button
                className={cn(choiceClassShared(resolution === r), "flex-1")}
                key={r}
                onClick={() => setResolution(r)}
                type="button"
              >
                {r}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Aspect — txt2vid only (img2vid adapts to the frame). */}
      {!isImg2Vid && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.aspect")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {eco.aspectRatios.map((a) => (
              <button
                className={cn(choiceClassShared(aspect === a), "px-2.5")}
                key={a}
                onClick={() => setAspect(a)}
                type="button"
              >
                {a}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Audio toggle (veo3/seedance/kling-v3). */}
      {hasAudio && (
        <label className="flex cursor-pointer items-center gap-2 text-sm">
          <input checked={audio} onChange={(e) => setAudio(e.target.checked)} type="checkbox" />
          {t("videoGenerator.audio")}
        </label>
      )}

      {/* Seed */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="video-seed">
          {t("generator.seed")}
        </Label>
        <Input
          className="h-8 rounded-[8px]"
          id="video-seed"
          inputMode="numeric"
          onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))}
          placeholder={t("generator.seedRandom")}
          value={seed}
        />
      </div>
    </div>
  );

  return (
    <AssetShell subtitle={t("videoGenerator.subtitle")} title={t("generator.title")} onBack={onBack}>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section className="bg-card flex w-full shrink-0 flex-col border-b lg:w-[400px] lg:border-r lg:border-b-0">
          <div className="min-h-0 flex-1 overflow-y-auto pb-24 overscroll-auto lg:overscroll-contain lg:pb-0">
            {form}
          </div>
          <div className="fixed inset-x-0 bottom-0 z-20 border-t bg-card p-3 lg:static lg:inset-auto">
            <div className="flex items-stretch gap-2">
              <div
                className="flex h-10 shrink-0 items-center gap-1 rounded-[8px] border bg-secondary px-2.5"
                title={t("videoGenerator.costNote")}
              >
                {costError ? (
                  <Icon className="text-destructive size-4" name="info" />
                ) : cost ? (
                  <>
                    <Icon className="text-warning size-3.5" name="zap" />
                    <span className="text-warning text-[13px] font-semibold">≈{Math.round(cost.totalBuzz)}</span>
                  </>
                ) : (
                  <Spinner className="size-3.5" />
                )}
              </div>
              <Button
                className="h-10 flex-1 rounded-[8px] text-[15px] font-semibold"
                disabled={!canSubmit}
                onClick={() => void handleGenerate()}
                size="lg"
              >
                {submitting ? (
                  <span className="flex items-center gap-2">
                    <Spinner className="size-4" />
                    {t("videoGenerator.submitting")}
                  </span>
                ) : job ? (
                  t("videoGenerator.inProgress")
                ) : (
                  t("generator.generate")
                )}
              </Button>
            </div>
            <p className="text-muted-foreground/70 mt-1.5 text-center text-[10px]">{t("videoGenerator.costNote")}</p>
          </div>
        </section>

        <section className="flex min-h-[60vh] min-w-0 flex-1 flex-col border-t lg:min-h-0 lg:border-t-0">
          <div className="text-muted-foreground flex items-center justify-between gap-2 border-b px-3 py-2 text-[11px]">
            <span className="text-foreground text-xs font-semibold">{t("videoGenerator.results")}</span>
            <span>{t("generator.resultsCount", { count: results.length })}</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-auto p-3 lg:overscroll-contain">
            {job && (
              <div className="mb-3">
                <JobCard job={job} status={status} elapsed={elapsed} />
              </div>
            )}
            {results.length === 0 && !job ? (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center">
                <Icon className="size-16 stroke-1" name="inbox" />
                <p className="text-foreground text-sm font-medium">{t("videoGenerator.noResults")}</p>
                <p className="max-w-56 text-xs">{t("videoGenerator.noResultsHint")}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {results.map((entry) => (
                  <VideoResultCard entry={entry} key={entry.fileId} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </AssetShell>
  );
}

/** Standalone choice chip — shared visual language with the image panel. */
function choiceClassShared(active: boolean): string {
  return cn(
    "rounded-[8px] border px-2.5 py-1.5 text-xs font-medium transition-colors",
    active ? "border-primary bg-secondary text-primary" : "bg-secondary text-muted-foreground hover:text-foreground",
  );
}
