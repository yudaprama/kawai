import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";
import { call } from "@/lib/api";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { useFilePreview } from "@/lib/preview-file";
import { useI18n } from "@/hooks/use-i18n";
import { Masonry, useColumnCount } from "./masonry";
import {
  DEFAULT_VIDEO_ECOSYSTEM,
  VIDEO_ECOSYSTEMS,
  type VideoEcosystemConfig,
  type VideoWorkflowId,
  videoAspects,
  videoDurationChoices,
  videoDurationOmitted,
  videoDurationRange,
  videoEcosystem,
  videoHasAudio,
  videoHasNegative,
  videoHasPromptEnhancer,
  videoHasEdit,
  videoMaxFrames,
  videoRefMax,
  videoResolutions,
} from "./video-ecosystems";
import {
  KeyStatusNotices,
  type GenerationJobRow,
  type LaneResultEntry,
  laneStatusKey,
  type LaneStatusView,
  readFileAsDataUrl,
  useCivitaiKeyStatus,
  useEcoGroups,
  useWorkflowLane,
} from "./civitai-shared";
import { GenerateFooter } from "./generate-footer";
import { ResultActions, mediaToken } from "./result-actions";
import {
  ChoiceChip,
  detailLine,
  EcoPicker,
  EmptyResults,
  GeneratorLayout,
  JobCard,
  resultMeta,
  ResultsPaneHeader,
  ToggleRow,
} from "./generator-shell";

/** Civitai videoGen request the Rust ops accept (camelCase, flattened). */
interface VideoGenRequest {
  ecosystem: string;
  workflow: VideoWorkflowId;
  prompt: string;
  negativePrompt?: string;
  /** Ordered: img2vid = [first, (last)]; ref2vid = references. */
  images: string[];
  /** Source video for the edit lane (grok v1.0). */
  video?: string;
  model?: string;
  mode?: string;
  fastMode?: boolean;
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  generateAudio?: boolean;
  enablePromptEnhancer?: boolean;
  cfgScale?: number;
  steps?: number;
  draft?: boolean;
  style?: string;
  movementAmplitude?: string;
  seed?: number;
  quantity?: number;
}

interface VideoBlobView {
  videoUrl: string;
  thumbnailUrl?: string;
  width?: number;
  height?: number;
}

interface VideoStatusView extends LaneStatusView {
  video?: VideoBlobView;
  /** LTX-style batched jobs: extra clips beyond the primary. */
  additional: VideoBlobView[];
}

interface SavedVideo {
  fileId: string;
  name: string;
  thumbnailFileId?: string;
  additional?: Array<{ fileId: string; name: string }>;
}

interface VideoResultEntry extends LaneResultEntry<ReusableVideoReq> {
  thumbnailFileId?: string;
}

/** The `VideoGenRequest` behind a result, minus the uploaded media — a base64
 *  frame or mp4 has no business in localStorage, and the slot is re-picked by
 *  hand anyway. `hadMedia` records that the run consumed one. */
type ReusableVideoReq = Omit<VideoGenRequest, "images" | "video"> & { hadMedia?: boolean };

function stripVideoReq(req: VideoGenRequest): ReusableVideoReq {
  const { images, video, ...rest } = req;
  return images.length > 0 || video ? { ...rest, hadMedia: true } : rest;
}

const JOB_KEY = "kawai-generator-video-job-v1";

/** History row → result entries. Files flagged `thumb` are poster renders —
 *  paired with the entry before them instead of listed as cards. */
function videoEntriesFromJob(row: GenerationJobRow): VideoResultEntry[] {
  let req = {} as ReusableVideoReq;
  try {
    req = JSON.parse(row.paramsJson || "{}") as ReusableVideoReq;
  } catch {
    // A row with an unparseable snapshot still lists its media.
  }
  const thumbs = row.files.filter((f) => f.thumb);
  return row.files
    .filter((f) => !f.thumb)
    .map((f, i) => ({
      fileId: f.id,
      name: f.name,
      jobId: row.id,
      thumbnailFileId: thumbs[i]?.id,
      prompt: (req.prompt ?? "").trim(),
      at: row.createdAt * 1000,
      req,
    }));
}

/** One `civitai_video_template_gallery` preset — a community clip WITH the
 *  generation settings civitai recorded for it. Inspiration, not reproduction:
 *  the seed is left to the form. */
interface VideoTemplatePreset {
  url: string;
  thumbnail: string;
  width: number;
  height: number;
  prompt: string;
  ecosystem: string;
  model: string | null;
  duration: number | null;
  aspect: string | null;
  steps: number | null;
  cfgScale: number | null;
  draft: boolean | null;
  aspectLabel: string;
}

/**
 * Community txt2vid clips for the selected engine, shown in place of the
 * empty state. Replaces the old "Nothing generated yet" panel: browsing what
 * other people actually made is the point of a gallery, and the previous
 * layout stacked preset chips ON TOP of that empty-state copy, which read as
 * a contradiction ("no results" next to "here are results").
 *
 * Skeletons while loading; a genuine empty state when the engine has no
 * community txt2vid clips yet (coverage is uneven — several engines have
 * none) — that one says so plainly instead of blaming the user's history.
 */
function VideoTemplateGallery({
  ecosystem,
  onApply,
}: {
  ecosystem: string;
  onApply: (preset: VideoTemplatePreset) => void;
}) {
  const { t } = useI18n();
  // Community clips are NOT uniform (704x960, 864x480, 832x1504 all on one
  // page), so the grid is a masonry: a row-synced grid forces one height and
  // crops the rest, which is what made every tile look square.
  const cols = useColumnCount(3);
  const [presets, setPresets] = useState<VideoTemplatePreset[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setPresets(null);
    setFailed(false);
    call<VideoTemplatePreset[]>("civitai_video_template_gallery", { ecosystem })
      .then((list) => {
        if (alive) setPresets(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (!alive) return;
        setFailed(true);
        setPresets([]);
      });
    return () => {
      alive = false;
    };
  }, [ecosystem]);

  if (presets === null) {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {(["a", "b", "c", "d", "e", "f"] as const).map((k) => (
          <Skeleton className="aspect-video w-full rounded-lg" key={k} />
        ))}
      </div>
    );
  }

  if (presets.length === 0) {
    return (
      <EmptyResults
        description={failed ? t("videoGenerator.presetsUnavailable") : t("videoGenerator.presetsEmpty")}
        title={failed ? t("videoGenerator.presetsErrorTitle") : t("videoGenerator.presetsEmptyTitle")}
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{t("videoGenerator.presetsHint")}</p>
      <Masonry
        cols={cols}
        items={presets}
        keyOf={(preset) => preset.url}
        render={(preset) => <AutoplayTile index={presets.indexOf(preset)} onApply={onApply} preset={preset} />}
      />
    </div>
  );
}

/** How many gallery clips may decode video at once. */
const AUTOPLAY_CONCURRENCY = 4;

/**
 * One gallery tile, playing its clip in place the way civitai's own feed
 * does. Autoplay only works muted, so the clips are silent by design —
 * civitai's community feed mutes for the same reason.
 *
 * The clips are NOT cheap: measured 1.2–15.6 MB each (mean ~5.5 MB), and
 * every byte rides the worker proxy on an ISP-filtered network. Twelve
 * looping tiles is ~12 MB/s of proxy bandwidth for a panel that is idle most
 * of the time, so playback is gated three ways:
 *
 *   1. `preload="none"` — nothing is fetched until the tile is scrolled near.
 *   2. An IntersectionObserver — a tile only plays while it is actually on
 *      screen (civitai does the same), and `rootMargin` leaves a screen of
 *      slack so scrolling starts playback before the tile arrives.
 *   3. A concurrency cap — only the first `AUTOPLAY_CONCURRENCY` visible
 *      tiles play. Browsers already cap concurrent video decoders, but
 *      failing open (queueing silently) leaves tiles stuck on a spinner.
 *
 * The poster stays as the element background, so a tile that never plays —
 * capped out, still buffering, or blocked by an autoplay policy — shows the
 * frame instead of a black box.
 */
function AutoplayTile({
  index,
  onApply,
  preset,
}: {
  index: number;
  onApply: (preset: VideoTemplatePreset) => void;
  preset: VideoTemplatePreset;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [visible, setVisible] = useState(false);
  // Position in DOM order, used for the concurrency cap.
  const play = visible && index < AUTOPLAY_CONCURRENCY;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)), {
      rootMargin: "200px",
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (play) {
      void node.play().catch(() => {
        // Autoplay policy or a decode failure — the poster remains.
      });
    } else {
      node.pause();
    }
  }, [play]);

  return (
    // The ratio lives on the BUTTON, never on the media elements. `<video>`
    // and `<img>` are replaced elements: they carry an intrinsic ratio (a
    // `<video>` defaults to 2:1 before metadata loads) that wins over a CSS
    // `aspect-ratio` on the element itself, which is what made every tile
    // render at the same height regardless of the clip. Sizing the container
    // and letting both children fill it with `object-cover` is deterministic.
    <button
      className="group border-muted-foreground/70 hover:border-ring relative block w-full cursor-pointer overflow-hidden rounded-lg border text-left transition-colors"
      onClick={() => onApply(preset)}
      style={{ aspectRatio: `${preset.width} / ${preset.height}` }}
      title={preset.prompt}
      type="button"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" src={preset.thumbnail} />
      <video
        aria-hidden="true"
        className={`absolute inset-0 h-full w-full object-cover transition-opacity ${play ? "opacity-100" : "opacity-0"}`}
        loop
        muted
        playsInline
        poster={preset.thumbnail}
        preload="none"
        ref={ref}
        tabIndex={-1}
      >
        <source src={preset.url} type="video/mp4" />
      </video>
      <span className="text-muted-foreground absolute top-1.5 left-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">
        {preset.duration ? `${preset.duration}s` : preset.aspectLabel}
      </span>
    </button>
  );
}

/** One saved video result: poster tile with a play badge — the mp4 itself is
 *  only read when the card is clicked (the preview overlay plays it). A grid
 *  of 30 tiles used to pull every clip's full bytes into memory. */

function VideoResultCard({
  entry,
  onRemove,
  onReuse,
}: {
  entry: VideoResultEntry;
  onRemove: () => void;
  onReuse: () => void;
}) {
  const { t } = useI18n();
  const thumb = useFilePreview(
    entry.thumbnailFileId ? { id: entry.thumbnailFileId, name: `${entry.name}-thumb.jpg` } : { id: "", name: "" },
  );
  return (
    <div className="group relative overflow-hidden rounded-[8px] border bg-secondary">
      <button
        className="block w-full cursor-zoom-in"
        onClick={() => emitOpenPreview(entry.fileId, entry.name)}
        title={entry.prompt}
        type="button"
      >
        <div className="relative flex aspect-video w-full items-center justify-center bg-black">
          {thumb.isLoading ? (
            <Spinner className="size-5 text-white" />
          ) : thumb.data?.dataUrl ? (
            <img alt={entry.prompt} className="h-full w-full object-cover" src={thumb.data.dataUrl} />
          ) : (
            <span className="text-muted-foreground text-xs">{t("videoGenerator.posterMissing")}</span>
          )}
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex size-10 items-center justify-center rounded-full bg-black/60 text-white/90">
              <Icon className="size-5" name="play" />
            </span>
          </span>
        </div>
      </button>
      <ResultActions
        fileId={entry.fileId}
        fileName={entry.name}
        label={entry.prompt || entry.name}
        meta={resultMeta(entry.at, videoDetail(entry.req))}
        onRemove={onRemove}
        onReuse={onReuse}
        token={mediaToken(entry.prompt, entry.fileId, entry.name)}
      />
    </div>
  );
}

/** The detail line under a video card: what the run actually asked for. */
function videoDetail(req: ReusableVideoReq | undefined): string | undefined {
  return detailLine(req?.duration ? `${req.duration}s` : undefined, req?.resolution, req?.aspectRatio, req?.model);
}

/** One frame slot: pick chip when empty, thumbnail + clear when set.
 *  Shared with the 3D lane's source-image slot. */
export function FrameSlot({
  caption,
  dataUrl,
  onPick,
  onClear,
}: {
  caption: string;
  dataUrl: string;
  onPick: (file: File | undefined) => void;
  onClear: () => void;
}) {
  return dataUrl ? (
    <div className="relative overflow-hidden rounded-[8px] border">
      <img alt={caption} className="aspect-video w-full bg-black object-cover" src={dataUrl} />
      <span className="bg-black/60 absolute bottom-1 left-1 rounded px-1 text-[10px] text-white">{caption}</span>
      <Button
        aria-label={caption}
        className="absolute top-1 right-1 size-6"
        onClick={onClear}
        size="icon"
        variant="secondary"
      >
        <Icon className="size-3.5" name="x" />
      </Button>
    </div>
  ) : (
    <label className="text-muted-foreground flex aspect-video cursor-pointer flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed text-xs transition-colors hover:text-foreground">
      <Icon className="size-5" name="image-plus" />
      {caption}
      <input
        accept="image/jpeg,image/png,image/webp"
        className="hidden"
        onChange={(e) => onPick(e.target.files?.[0])}
        type="file"
      />
    </label>
  );
}

export function VideoGenerator() {
  const { t } = useI18n();
  const configured = useCivitaiKeyStatus();
  const [ecoId, setEcoId] = useState(DEFAULT_VIDEO_ECOSYSTEM);
  const eco: VideoEcosystemConfig = videoEcosystem(ecoId);
  const [modelKey, setModelKey] = useState("");
  const [workflow, setWorkflow] = useState<VideoWorkflowId>("txt2vid");
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  /** Source frames, ordered — semantics per workflow (img2vid slots or refs). */
  const [frames, setFrames] = useState<string[]>([]);
  /** Source video (edit lane, grok v1.0). */
  const [sourceVideo, setSourceVideo] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(6);
  const [resolution, setResolution] = useState<string>("");
  const [aspect, setAspect] = useState<string>("16:9");
  const [audio, setAudio] = useState(false);
  const [seed, setSeed] = useState("");
  const [enhancer, setEnhancer] = useState(true);
  const [cfgScale, setCfgScale] = useState("");
  const [steps, setSteps] = useState("");
  const [draft, setDraft] = useState(false);
  const [style, setStyle] = useState("");
  const [movement, setMovement] = useState("");

  // Ecosystem/model switches reset every dependent selection to the new
  // ecosystem's first valid value (duration/resolution/aspect are wire
  // enums — a stale pick would fail the whatif).
  const durationChoices = videoDurationChoices(ecoId, modelKey);
  const durationRange = videoDurationRange(ecoId, modelKey);
  /** (Re)initialize every model/workflow-dependent pick. Duration lands on
   *  the choices midpoint (or slider middle); resolution/aspect on the
   *  first valid value; frames trimmed to the new caps. */
  const reinitPicks = useCallback((id: string, model: string) => {
    const range = videoDurationRange(id, model);
    const choices = videoDurationChoices(id, model);
    setDuration(
      videoDurationOmitted(id, model)
        ? 0
        : choices
          ? choices[Math.floor(choices.length / 2)]
          : Math.round((range.min + range.max) / 2),
    );
    const res = videoResolutions(id, model);
    setResolution(res[0] ?? "");
    const asp = videoAspects(id, model);
    setAspect(asp.includes("16:9") ? "16:9" : (asp[0] ?? ""));
    // LTX is the one engine whose audio defaults ON.
    setAudio(id === "ltx");
    setDraft(false);
    setStyle("");
    setMovement("");
    setCfgScale("");
    setSteps("");
    setEnhancer(true);
    setFrames((prev) => prev.slice(0, videoMaxFrames(id, model)));
  }, []);
  const switchEcosystem = useCallback(
    (id: string) => {
      setEcoId(id);
      setModelKey(id === "kling" ? "" : (videoEcosystem(id).models[0]?.key ?? ""));
      reinitPicks(id, id === "kling" ? "" : (videoEcosystem(id).models[0]?.key ?? ""));
    },
    [reinitPicks],
  );
  const switchModel = useCallback(
    (key: string) => {
      setModelKey(key);
      reinitPicks(ecoId, key);
    },
    [ecoId, reinitPicks],
  );

  const hasAudio = videoHasAudio(ecoId, modelKey);
  const hasNegative = videoHasNegative(ecoId, modelKey);
  const promptEnhancer = videoHasPromptEnhancer(ecoId, modelKey);
  const isEdit = videoHasEdit(ecoId, modelKey) && workflow === "vid2vid:edit";
  const isImageWorkflow = workflow === "img2vid" || workflow === "img2vid:ref2vid";
  const isRef2Vid = workflow === "img2vid:ref2vid";
  const maxFrames = videoMaxFrames(ecoId, modelKey);
  const refMax = videoRefMax(ecoId, modelKey);
  const resolutions = videoResolutions(ecoId, modelKey);
  const aspects = videoAspects(ecoId, modelKey);
  const durationHidden = videoDurationOmitted(ecoId, modelKey);
  const promptEffective = isEdit || isImageWorkflow || prompt.trim().length > 0;
  /** Slot count the current workflow renders: img2vid = maxFrames
   *  (first required, last optional), ref2vid grows with an add-slot. */
  const frameSlots = isRef2Vid ? Math.max(1, frames.length) : maxFrames;
  const framesFilled = frames.filter(Boolean).length;
  const videoReady = !isEdit || sourceVideo != null;
  const framesReady = !isImageWorkflow || framesFilled >= 1;
  const canAddFrameSlot = isImageWorkflow && frames.length < (isRef2Vid ? refMax : maxFrames);

  const buildRequest = useCallback((): VideoGenRequest => {
    return {
      ecosystem: ecoId,
      workflow,
      prompt: prompt.trim(),
      negativePrompt: hasNegative && negativePrompt.trim() ? negativePrompt.trim() : undefined,
      images: workflow === "img2vid" || workflow === "img2vid:ref2vid" ? frames.filter(Boolean) : [],
      video: isEdit && sourceVideo ? sourceVideo : undefined,
      model: modelKey || undefined,
      duration: durationHidden ? undefined : duration,
      resolution: resolutions.length > 0 ? resolution || resolutions[0] : undefined,
      aspectRatio: workflow === "txt2vid" ? aspect : undefined,
      generateAudio: hasAudio ? audio : undefined,
      enablePromptEnhancer: promptEnhancer ? enhancer : undefined,
      cfgScale: eco.cfgRange && cfgScale.trim() ? Number(cfgScale) : undefined,
      steps: eco.stepsRange && steps.trim() ? Number(steps) : undefined,
      draft: eco.draft && draft ? true : undefined,
      style: style.trim() || undefined,
      movementAmplitude: movement.trim() || undefined,
      seed: seed.trim() ? Number(seed) : undefined,
      quantity: 1,
    };
  }, [
    audio,
    aspect,
    cfgScale,
    draft,
    duration,
    durationHidden,
    eco,
    ecoId,
    enhancer,
    frames,
    hasAudio,
    hasNegative,
    isEdit,
    modelKey,
    movement,
    negativePrompt,
    prompt,
    promptEnhancer,
    resolutions,
    resolution,
    sourceVideo,
    seed,
    steps,
    style,
    workflow,
  ]);

  const lane = useWorkflowLane<VideoGenRequest, ReusableVideoReq, VideoStatusView, SavedVideo, VideoResultEntry>({
    configured,
    formEffective: promptEffective && videoReady && framesReady,
    lane: "video",
    keys: { job: JOB_KEY },
    fromJob: videoEntriesFromJob,
    ops: {
      cost: "civitai_video_cost",
      status: "civitai_video_status",
      submit: "civitai_video_submit",
      fetch: "civitai_video_fetch",
    },
    labels: { done: "videoGenerator.done", failed: "videoGenerator.failedToast" },
    stuckMs: 30 * 60 * 1000,
    buildRequest,
    strip: stripVideoReq,
    promptLabel: () => prompt.trim(),
    succeeded: (st) => st.status === "succeeded" && st.video != null,
    fetchSaved: (st, workflowId) =>
      call<SavedVideo>("civitai_video_fetch", {
        workflowId,
        videoUrl: st.video?.videoUrl,
        thumbnailUrl: st.video?.thumbnailUrl,
        additionalUrls: (st.additional ?? []).map((c) => c.videoUrl),
      }),
  });
  const { cancel, cost, costError, elapsed, job, removeEntry, results, status, submit, submitting } = lane;
  const {
    groups: ecoGroups,
    open: ecoOpen,
    setOpen: setEcoOpen,
  } = useEcoGroups(VIDEO_ECOSYSTEMS, ecoId, switchEcosystem);

  async function setSourceVideoSlot(file: File | undefined) {
    if (!file) return;
    if (file.type !== "video/mp4" && file.type !== "video/webm") {
      toast.error(t("videoGenerator.videoType"));
      return;
    }
    if (file.size > 64 * 1024 * 1024) {
      toast.error(t("videoGenerator.sourceTooLarge"));
      return;
    }
    setSourceVideo(await readFileAsDataUrl(file));
  }

  async function setFrameSlot(index: number, file: File | undefined) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error(t("videoGenerator.sourceTooLarge"));
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    if (dataUrl == null) return;
    setFrames((prev) => {
      const next = [...prev];
      while (next.length <= index) next.push("");
      next[index] = dataUrl;
      return next;
    });
  }

  /** Load a curated preset into the form. Like `reuseEntry`, `reinitPicks`
   *  runs FIRST because it resets every engine-dependent pick — the preset's
   *  own values must land after it. Presets are txt2vid only, so any
   *  uploaded frame/clip is dropped rather than silently ignored. */
  /** Load a community clip's settings back into the form. `reinitPicks` runs
   *  FIRST — it resets every engine-dependent pick, so the clip's own values
   *  must land after it. Clips are txt2vid only, so any uploaded frame or
   *  source video is dropped rather than silently ignored. Resolution is NOT
   *  restored: the clip's pixel size is not the engine's quality tier
   *  ("1080p"), so copying it across would be meaningless. */
  function applyVideoPreset(preset: VideoTemplatePreset) {
    const model = preset.model ?? "";
    setEcoId(preset.ecosystem);
    setModelKey(model);
    reinitPicks(preset.ecosystem, model);
    setWorkflow("txt2vid");
    setPrompt(preset.prompt);
    setFrames([]);
    setSourceVideo(null);
    if (preset.duration != null && !videoDurationOmitted(preset.ecosystem, model)) {
      const range = videoDurationRange(preset.ecosystem, model);
      setDuration(Math.min(range.max, Math.max(range.min, preset.duration)));
    }
    if (preset.aspect) setAspect(preset.aspect);
    if (preset.draft != null) setDraft(preset.draft);
    if (preset.steps != null) setSteps(String(preset.steps));
    if (preset.cfgScale != null) setCfgScale(String(preset.cfgScale));
    toast.success(t("videoGenerator.presetApplied"));
  }

  /** Load a result's generating settings back into the form. `reinitPicks`
   *  runs first — it resets every model/workflow-dependent pick, so the
   *  persisted values must land after it. Uploaded frames are never kept
   *  with the result, so image-input workflows re-ask for them. */
  function reuseEntry(entry: VideoResultEntry) {
    const r = entry.req;
    if (!r) {
      setPrompt(entry.prompt);
      toast.success(t("generator.settingsReusedPromptOnly"));
      return;
    }
    const nextEco = videoEcosystem(r.ecosystem).id === r.ecosystem ? r.ecosystem : DEFAULT_VIDEO_ECOSYSTEM;
    const nextModel = r.model ?? (nextEco === "kling" ? "" : (videoEcosystem(nextEco).models[0]?.key ?? ""));
    setEcoId(nextEco);
    setModelKey(nextModel);
    reinitPicks(nextEco, nextModel);
    setWorkflow(r.workflow);
    setPrompt(r.prompt);
    setNegativePrompt(r.negativePrompt ?? "");
    setFrames([]);
    setSourceVideo(null);
    if (r.duration != null && !videoDurationOmitted(nextEco, nextModel)) {
      const range = videoDurationRange(nextEco, nextModel, r.resolution);
      setDuration(Math.min(range.max, Math.max(range.min, r.duration)));
    }
    if (r.resolution && videoResolutions(nextEco, nextModel).includes(r.resolution)) setResolution(r.resolution);
    if (r.aspectRatio && videoAspects(nextEco, nextModel).includes(r.aspectRatio)) setAspect(r.aspectRatio);
    if (r.generateAudio != null) setAudio(r.generateAudio);
    if (r.enablePromptEnhancer != null) setEnhancer(r.enablePromptEnhancer);
    if (r.draft != null) setDraft(r.draft);
    if (r.cfgScale != null) setCfgScale(String(r.cfgScale));
    if (r.steps != null) setSteps(String(r.steps));
    if (r.style) setStyle(r.style);
    if (r.movementAmplitude) setMovement(r.movementAmplitude);
    setSeed(r.seed != null ? String(r.seed) : "");
    toast.success(t("generator.settingsReused"));
    if (r.hadMedia) toast.info(t("generator.sourceNotRestored"));
  }

  const form = (
    <div className="flex flex-col gap-3 p-3">
      <EcoPicker
        ecoAriaLabel={t("videoGenerator.ecosystem")}
        ecoGroups={ecoGroups}
        ecoLabel={eco.label}
        ecoOpen={ecoOpen}
        onEcoOpenChange={setEcoOpen}
      />
      <KeyStatusNotices configured={configured} />

      {/* Workflow — txt2vid / img2vid segmented chips. */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.workflow")}</Label>
        <div className="flex gap-2">
          {(
            [
              ["txt2vid", t("videoGenerator.txt2vid")],
              ["img2vid", t("videoGenerator.img2vid")],
              ["img2vid:ref2vid", t("videoGenerator.ref2vid")],
              ...(videoHasEdit(ecoId, modelKey)
                ? ([["vid2vid:edit", t("videoGenerator.edit2vid")]] as Array<[VideoWorkflowId, string]>)
                : []),
            ] as Array<[VideoWorkflowId, string]>
          )
            .filter(([id]) => eco.workflows.includes(id))
            .map(([id, label]) => (
              <ChoiceChip
                active={workflow === id}
                className="flex-1"
                key={id}
                onClick={() => {
                  setWorkflow(id);
                  // Trim frames to the new workflow's cap (refs start fresh).
                  setFrames((prev) => (id === "img2vid:ref2vid" ? prev : prev.slice(0, 2)));
                }}
              >
                {label}
              </ChoiceChip>
            ))}
        </div>
      </div>

      {/* Prompt — directly under the workflow pick, before the model chips:
          it is the field the user came here to fill. */}
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

      {/* Model chips — ecosystems with more than the default pick. */}
      {eco.models.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("generator.model")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {eco.models.map((m) => (
              <ChoiceChip
                active={modelKey === m.key}
                className="px-3"
                key={m.key || "default"}
                onClick={() => switchModel(m.key)}
              >
                {m.label}
              </ChoiceChip>
            ))}
          </div>
        </div>
      )}

      {/* Negative prompt (kling legacy, veo3, wan). Same outcome-phrased label
          as the image lane — "Exclude from video" reads without knowing the
          model parameter. */}
      {hasNegative && (
        <div className="flex flex-col gap-1.5">
          <Label
            className="flex items-center gap-1 text-[13px] font-medium text-muted-foreground"
            htmlFor="video-negative"
          >
            {t("videoGenerator.negativePromptTitle")}
            <span className="text-xs text-muted-foreground/70">· {t("videoGenerator.negativePromptOptional")}</span>
          </Label>
          <Input
            className="h-8 rounded-[8px]"
            id="video-negative"
            onChange={(e) => setNegativePrompt(e.target.value)}
            placeholder={t("videoGenerator.negativePromptPlaceholder")}
            value={negativePrompt}
          />
        </div>
      )}

      {/* Source video — edit lane. */}
      {isEdit && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.sourceVideo")}</Label>
          {sourceVideo ? (
            <div className="relative overflow-hidden rounded-[8px] border">
              <video className="aspect-video w-full bg-black object-contain" controls playsInline src={sourceVideo}>
                <track kind="captions" />
              </video>
              <Button
                aria-label={t("videoGenerator.clearImage")}
                className="absolute top-1.5 right-1.5 size-6"
                onClick={() => setSourceVideo(null)}
                size="icon"
                variant="secondary"
              >
                <Icon className="size-3.5" name="x" />
              </Button>
            </div>
          ) : (
            <label className="text-muted-foreground flex aspect-video cursor-pointer flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed text-xs transition-colors hover:text-foreground">
              <Icon className="size-5" name="video" />
              {t("videoGenerator.pickVideo")}
              <input
                accept="video/mp4,video/webm"
                className="hidden"
                onChange={(e) => setSourceVideoSlot(e.target.files?.[0])}
                type="file"
              />
            </label>
          )}
        </div>
      )}

      {/* Frame slots — img2vid (first required, last optional) or refs. */}
      {isImageWorkflow && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">
            {isRef2Vid ? t("videoGenerator.refFrames", { max: refMax }) : t("videoGenerator.frameSlots")}
          </Label>
          <div className={cn("grid gap-2", frameSlots > 1 && "grid-cols-2")}>
            {Array.from({ length: frameSlots }, (_, i) => (
              <FrameSlot
                // biome-ignore lint/suspicious/noArrayIndexKey: slot positions are fixed by the workflow (first/last), never reordered
                key={`slot-${i}`}
                caption={
                  isRef2Vid
                    ? t("videoGenerator.refN", { n: i + 1 })
                    : i === 0
                      ? t("videoGenerator.firstFrame")
                      : t("videoGenerator.lastFrame")
                }
                dataUrl={frames[i] ?? ""}
                onClear={() =>
                  setFrames((prev) => {
                    const next = [...prev];
                    next[i] = "";
                    // Drop trailing empties so dead slots never render.
                    while (next.length > 1 && next[next.length - 1] === "") next.pop();
                    return next;
                  })
                }
                onPick={(file) => setFrameSlot(i, file)}
              />
            ))}
          </div>
          {isRef2Vid && canAddFrameSlot && (
            <Button
              className="h-8 rounded-[8px] text-xs"
              onClick={() => setFrames((prev) => [...prev, ""])}
              size="sm"
              variant="secondary"
            >
              <Icon className="mr-1 size-3.5" name="plus" /> {t("videoGenerator.addRef")}
            </Button>
          )}
        </div>
      )}

      {/* Duration — discrete chips or a slider; hidden when the engine
          takes no duration (vidu q1). */}
      {!durationHidden && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="video-duration">
            {t("videoGenerator.duration", { seconds: duration })}
          </Label>
          {durationChoices ? (
            <div className="flex gap-1.5">
              {durationChoices.map((d) => (
                <ChoiceChip active={duration === d} className="flex-1" key={d} onClick={() => setDuration(d)}>
                  {d}s
                </ChoiceChip>
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
      )}

      {/* Resolution — engines that take one (per-model lists). */}
      {resolutions.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.resolution")}</Label>
          <div className="flex gap-1.5">
            {resolutions.map((r) => (
              <ChoiceChip active={resolution === r} className="flex-1" key={r} onClick={() => setResolution(r)}>
                {r}
              </ChoiceChip>
            ))}
          </div>
        </div>
      )}

      {/* Aspect — text-driven workflows only (frames dictate it). */}
      {workflow === "txt2vid" && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.aspect")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {aspects.map((a) => (
              <ChoiceChip active={aspect === a} key={a} onClick={() => setAspect(a)}>
                {a}
              </ChoiceChip>
            ))}
          </div>
        </div>
      )}

      {/* Audio toggle (veo3/seedance/kling-v3). */}
      {hasAudio && <ToggleRow checked={audio} label={t("videoGenerator.audio")} onCheckedChange={setAudio} />}

      {/* Style + movement (vidu q1). */}
      {(eco.styles.length > 0 || eco.movements.length > 0) && modelKey !== "q3" && (
        <div className="grid grid-cols-2 gap-2">
          {eco.styles.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.style")}</Label>
              <div className="flex gap-1.5">
                {eco.styles.map((st) => (
                  <ChoiceChip
                    active={style === st}
                    className="flex-1 px-2"
                    key={st}
                    onClick={() => setStyle(style === st ? "" : st)}
                  >
                    {st === "anime" ? t("videoGenerator.style_anime") : t("videoGenerator.style_general")}
                  </ChoiceChip>
                ))}
              </div>
            </div>
          )}
          {eco.movements.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-[13px] font-medium">{t("videoGenerator.movement")}</Label>
              <Select value={movement || "auto"} onValueChange={setMovement}>
                <SelectTrigger className="h-8 rounded-[8px]">
                  <span>{movement || "auto"}</span>
                </SelectTrigger>
                <SelectContent>
                  {eco.movements.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      )}

      {/* Hunyuan CFG + steps sliders (registry ranges). */}
      {eco.cfgRange && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="video-cfg">
            {t("generator.cfgScale")}
          </Label>
          <Slider
            id="video-cfg"
            max={eco.cfgRange.max}
            min={eco.cfgRange.min}
            onValueChange={(v) => setCfgScale(String(v[0]))}
            step={1}
            value={[Number(cfgScale) || eco.cfgRange.default]}
          >
            <SliderTrack>
              <SliderRange />
            </SliderTrack>
            <SliderThumb aria-label={t("generator.cfgScale")} />
          </Slider>
        </div>
      )}
      {eco.stepsRange && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="video-steps">
            {t("generator.steps")}
          </Label>
          <Slider
            id="video-steps"
            max={eco.stepsRange.max}
            min={eco.stepsRange.min}
            onValueChange={(v) => setSteps(String(v[0]))}
            step={5}
            value={[Number(steps) || eco.stepsRange.default]}
          >
            <SliderTrack>
              <SliderRange />
            </SliderTrack>
            <SliderThumb aria-label={t("generator.steps")} />
          </Slider>
        </div>
      )}

      {/* Draft tier (flux3 pins 720p; vidu q3 turbo). */}
      {eco.draft && <ToggleRow checked={draft} label={t("videoGenerator.draft")} onCheckedChange={setDraft} />}

      {/* Prompt enhancer (kling legacy, vidu q1 — defaults ON). */}
      {promptEnhancer && (
        <ToggleRow checked={enhancer} label={t("videoGenerator.promptEnhancer")} onCheckedChange={setEnhancer} />
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
    <GeneratorLayout
      footer={
        <GenerateFooter
          canSubmit={lane.canSubmit}
          inFlight={job != null}
          inFlightLabel={t("videoGenerator.inProgress")}
          note={t("videoGenerator.costNote")}
          onSubmit={() => void submit()}
          quote={cost?.totalTokens ?? null}
          quoteState={
            costError ? "failed" : cost ? "quoted" : promptEffective && configured === true ? "pending" : "idle"
          }
          ready={cost?.ready ?? true}
          submitting={submitting}
          submittingLabel={t("videoGenerator.submitting")}
          submitLabel={t("generator.generate")}
          warnings={cost?.warnings ?? []}
        />
      }
      form={form}
      header={
        <ResultsPaneHeader
          meta={t("generator.resultsCount", { count: results.length })}
          title={t("videoGenerator.results")}
        />
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-auto p-3 lg:overscroll-contain">
        {job && (
          <div className="mb-3">
            <JobCard
              cancelLabel={t("videoGenerator.cancel")}
              elapsed={elapsed}
              error={status?.error}
              onCancel={cancel}
              queuePosition={status?.queuePosition}
              statusLabel={t(laneStatusKey("videoGenerator", status))}
              workflowId={job.workflowId}
            />
          </div>
        )}
        {results.length === 0 && !job ? (
          <VideoTemplateGallery ecosystem={ecoId} onApply={applyVideoPreset} />
        ) : (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {results.map((entry) => (
              <VideoResultCard
                entry={entry}
                key={entry.fileId}
                onRemove={() => removeEntry(entry)}
                onReuse={() => reuseEntry(entry)}
              />
            ))}
          </div>
        )}
      </div>
    </GeneratorLayout>
  );
}
