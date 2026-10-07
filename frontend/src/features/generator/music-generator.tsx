import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { refreshTokenBalance } from "@/features/topup/use-token-balance";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";
import { call, errText } from "@/lib/api";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { useFilePreview } from "@/lib/preview-file";
import { useI18n } from "@/hooks/use-i18n";
import {
  ACE_VARIANTS,
  DEFAULT_MUSIC_ECOSYSTEM,
  MUSIC_ECOSYSTEMS,
  aceCfgDefault,
  aceStepsRange,
  musicDurationRange,
  musicEcosystem,
  type MusicAceVariant,
  type MusicEcosystemId,
  type MusicMode,
  type MusicOperation,
  type MusicScoreMode,
} from "./music-ecosystems";
import { EcoOptionButton, KeyStatusNotices, useAliveEffect, useCivitaiKeyStatus } from "./civitai-shared";
import { ResultActions, mediaToken } from "./result-actions";

/** Civitai musicGen request the Rust ops accept (camelCase, only
 *  engine-relevant fields set). */
interface MusicGenRequest {
  ecosystem: MusicEcosystemId;
  mode?: MusicMode;
  operation?: MusicOperation;
  prompt?: string;
  caption?: string;
  lyrics?: string;
  abc?: string;
  scoreMode?: MusicScoreMode;
  steps?: number;
  bpm?: number;
  key?: string;
  instrumentalWeight?: number;
  vocalWeight?: number;
  cfgScale?: number;
  model?: MusicAceVariant;
  coverImage?: string;
  duration?: number;
  seed?: number;
}

interface MusicCostView {
  totalBuzz: number;
  /** App-token debit at submit (server-side ceil conversion). */
  totalTokens: number;
  ready: boolean;
  warnings: string[];
}

interface MusicStatusView {
  workflowId: string;
  status: string;
  queuePosition: number | null;
  audioUrl?: string;
  error?: string;
}

interface SavedAudio {
  fileId: string;
  name: string;
}

interface MusicResultEntry {
  fileId: string;
  name: string;
  prompt: string;
  ecosystem: MusicEcosystemId;
  at: number;
  /** Generating settings for the card's "Load these settings" action.
   *  Absent on entries logged before snapshots existed. */
  req?: ReusableMusicReq;
}

/** The `MusicGenRequest` behind a result, minus the uploaded cover art — a
 *  base64 data URL has no business in localStorage. `hadCover` records that
 *  the run consumed one. */
type ReusableMusicReq = Omit<MusicGenRequest, "coverImage"> & { hadCover?: boolean };

function stripMusicReq(req: MusicGenRequest): ReusableMusicReq {
  const { coverImage, ...rest } = req;
  return coverImage ? { ...rest, hadCover: true } : rest;
}

/** In-flight workflow, persisted so a restart resumes polling. */
interface ActiveJob {
  workflowId: string;
  prompt: string;
  at: number;
  /** The submitting request's scalar settings, carried through to the saved
   *  track so its card can load them back into the form. Absent on a job
   *  persisted by an older build. */
  req?: ReusableMusicReq;
}

const RESULTS_KEY = "civitai-music-results";
const JOB_KEY = "civitai-music-job";
const MAX_RESULTS = 24;
const STATUS_WAIT_SECS = 15;
/** Terminal-but-not-success states (lowercase wire vocabulary). */
const TERMINAL_FAILED: Record<string, true> = { failed: true, expired: true, canceled: true };

interface ModelCover {
  ecosystem: string;
  label: string;
  url: string | null;
  modelName: string | null;
}

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

/** Civitai's [media tabs …… Eco | <ecosystem>] strip — music lane active;
 *  the video/image tabs hand control back to their panels. */
function MediaIsland({
  ecoLabel,
  ecoOpen,
  onEcoClick,
  onSwitchToVideo,
  onSwitchToImage,
  children,
}: {
  ecoLabel: string;
  ecoOpen: boolean;
  onEcoClick: () => void;
  onSwitchToVideo: () => void;
  onSwitchToImage: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-[10px] border p-1.5">
      <div className={SEGMENTED_LIST}>
        <button className={segmentClass(false)} onClick={onSwitchToImage} title="Image" type="button">
          <Icon className="size-4" name="image" />
        </button>
        <button className={segmentClass(false)} onClick={onSwitchToVideo} title="Video" type="button">
          <Icon className="size-4" name="video" />
        </button>
        <span className={cn(segmentClass(true), "pointer-events-none")} title="Music">
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
        {ecoOpen && children}
      </div>
    </div>
  );
}

/** One saved music result: <audio> card, click opens preview. */
function MusicResultCard({
  entry,
  onRemove,
  onReuse,
}: {
  entry: MusicResultEntry;
  onRemove: () => void;
  onReuse: () => void;
}) {
  const main = useFilePreview({ id: entry.fileId, name: entry.name });
  return (
    <div className="group relative overflow-hidden rounded-[8px] border bg-secondary">
      <button
        className="block w-full p-2"
        onClick={() => emitOpenPreview(entry.fileId, entry.name)}
        title={entry.prompt}
        type="button"
      >
        {main.isLoading ? (
          <div className="flex h-14 items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <audio className="w-full" controls preload="metadata" src={main.data?.dataUrl}>
            <track kind="captions" />
          </audio>
        )}
      </button>
      <ResultActions
        downloadHref={main.data?.dataUrl}
        downloadName={entry.name}
        label={entry.prompt || entry.name}
        onRemove={onRemove}
        onReuse={onReuse}
        token={mediaToken(entry.prompt, entry.fileId, entry.name)}
      />
    </div>
  );
}

/** In-flight progress card pinned above the results grid. */
function JobCard({
  job,
  status,
  elapsed,
  onCancel,
}: {
  job: ActiveJob;
  status: MusicStatusView | null;
  elapsed: number;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const statusKey =
    status?.status === "processing"
      ? "musicGenerator.processing"
      : status?.status === "succeeded"
        ? "musicGenerator.succeeded"
        : "musicGenerator.queued";
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
          {t("musicGenerator.position", { position: status.queuePosition })}
        </p>
      )}
      {status?.error && <p className="text-destructive text-xs">{status.error}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground/60 truncate font-mono text-[10px]">{job.workflowId}</p>
        <Button className="h-7 shrink-0 rounded-[6px] px-2 text-xs" onClick={onCancel} size="sm" variant="secondary">
          {t("musicGenerator.cancel")}
        </Button>
      </div>
    </div>
  );
}

/** Standalone choice chip — shared visual language with the image panel. */
function choiceClassShared(active: boolean): string {
  return cn(
    "rounded-[8px] border px-2.5 py-1.5 text-xs font-medium transition-colors",
    active ? "border-primary bg-secondary text-primary" : "bg-secondary text-muted-foreground hover:text-foreground",
  );
}

export function MusicGenerator({
  onBack,
  onSwitchToVideo,
  onSwitchToImage,
}: {
  onBack: () => void;
  onSwitchToVideo: () => void;
  onSwitchToImage: () => void;
}) {
  const { t } = useI18n();
  const configured = useCivitaiKeyStatus();
  const [ecoId, setEcoId] = useState<MusicEcosystemId>(DEFAULT_MUSIC_ECOSYSTEM);
  const eco = musicEcosystem(ecoId);
  // Pinned-model card art — the shared covers op (1h server cache); keyed
  // by ecosystem. Cancelled on unmount like every fetch in the panel.
  const [musicCover, setMusicCover] = useState<ModelCover | null>(null);
  useEffect(() => {
    let cancelled = false;
    call<ModelCover[]>("civitai_model_covers")
      .then((list) => {
        if (!cancelled) setMusicCover(list.find((c) => c.ecosystem === ecoId) ?? null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [ecoId]);
  const [mode, setMode] = useState<MusicMode>("simple");
  const [operation, setOperation] = useState<MusicOperation>("music");
  const [prompt, setPrompt] = useState("");
  const [caption, setCaption] = useState("");
  const [lyrics, setLyrics] = useState("");
  const [abc, setAbc] = useState("");
  const [scoreMode, setScoreMode] = useState<MusicScoreMode>("full");
  const [steps, setSteps] = useState("");
  const [bpm, setBpm] = useState("");
  const [instrumentalWeight, setInstrumentalWeight] = useState("");
  const [vocalWeight, setVocalWeight] = useState("");
  const [cfgScale, setCfgScale] = useState("");
  const [variant, setVariant] = useState<MusicAceVariant>("xl-turbo");
  const [coverImage, setCoverImage] = useState<string | null>(null);
  const [duration, setDuration] = useState<number>(() => musicDurationRange(DEFAULT_MUSIC_ECOSYSTEM, "music").default);
  const [seed, setSeed] = useState("");
  // Civitai's SeedInput: Random (backend draws one) | Custom (numeric entry).
  const [seedMode, setSeedMode] = useState<"random" | "custom">("random");
  const [ecoOpen, setEcoOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Stepper input draft — free typing without the controlled-value clobbering
  // intermediate states like "0." (sonilo sfx steps by 0.5); committed on blur.
  const [durText, setDurText] = useState<string | null>(null);
  const [cost, setCost] = useState<MusicCostView | null>(null);
  const [costError, setCostError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<ActiveJob | null>(() => loadJson<ActiveJob | null>(JOB_KEY, null));
  const [status, setStatus] = useState<MusicStatusView | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<MusicResultEntry[]>(() => loadJson<MusicResultEntry[]>(RESULTS_KEY, []));
  const aliveRef = useRef(true);
  useAliveEffect(aliveRef);

  const isSonilo = ecoId === "sonilo";
  const isAce = ecoId === "ace";
  const isCustom = mode === "custom";
  const durRange = musicDurationRange(ecoId, isSonilo ? operation : "music");
  const durStep = durRange.step;
  const aceSteps = aceStepsRange(isAce ? variant : "xl-turbo");

  // Ecosystem/operation switches reset every dependent pick to the new
  // engine's first valid value (a stale pick would fail the whatif).
  const switchEcosystem = (id: MusicEcosystemId) => {
    setEcoId(id);
    setMode(musicEcosystem(id).modes[0]);
    setOperation("music");
    setDuration(musicDurationRange(id, "music").default);
    setPrompt("");
    setCaption("");
    setLyrics("");
    setAbc("");
    setScoreMode("full");
    setSteps("");
    setBpm("");
    setInstrumentalWeight("");
    setVocalWeight("");
    setCfgScale("");
    setVariant("xl-turbo");
    setCoverImage(null);
  };
  const switchOperation = (op: MusicOperation) => {
    setOperation(op);
    setDuration(musicDurationRange(ecoId, op).default);
  };
  const switchMode = (m: MusicMode) => {
    setMode(m);
    setSteps("");
    setCfgScale("");
  };

  const buildRequest = useCallback((): MusicGenRequest => {
    const req: MusicGenRequest = {
      ecosystem: ecoId,
      mode: eco.modes.includes("simple") ? mode : undefined,
      duration,
      seed: seedMode === "custom" && seed.trim() ? Number(seed) : undefined,
    };
    if (isSonilo) {
      req.operation = operation;
      req.prompt = prompt.trim();
      return req;
    }
    if (mode === "simple") {
      req.prompt = prompt.trim();
      return req;
    }
    // custom — per-engine fields, only engine-relevant ones set.
    req.caption = caption.trim();
    if (ecoId === "minimax-music3") {
      req.lyrics = lyrics;
    } else if (ecoId === "yue2") {
      req.lyrics = lyrics;
      req.scoreMode = scoreMode;
      req.abc = scoreMode !== "off" && abc.trim() ? abc : undefined;
      req.steps = steps.trim() ? Number(steps) : undefined;
    } else if (ecoId === "ace") {
      req.lyrics = lyrics.trim() || undefined;
      req.bpm = bpm.trim() ? Number(bpm) : undefined;
      req.instrumentalWeight = instrumentalWeight.trim() ? Number(instrumentalWeight) : undefined;
      req.vocalWeight = vocalWeight.trim() ? Number(vocalWeight) : undefined;
      req.steps = steps.trim() ? Number(steps) : undefined;
      req.cfgScale = cfgScale.trim() ? Number(cfgScale) : undefined;
      req.model = variant;
      req.coverImage = coverImage ?? undefined;
    }
    return req;
  }, [
    abc,
    bpm,
    caption,
    cfgScale,
    coverImage,
    duration,
    eco.modes,
    ecoId,
    instrumentalWeight,
    isSonilo,
    lyrics,
    mode,
    operation,
    prompt,
    scoreMode,
    seed,
    seedMode,
    steps,
    variant,
    vocalWeight,
  ]);

  const hasCaption = caption.trim().length > 0 && caption.length <= eco.promptMax;
  const hasLyrics = lyrics.trim().length > 0;
  const hasPrompt = prompt.trim().length > 0 && prompt.length <= eco.promptMax;
  /** Whether the form has everything the engine requires — the whatif
   *  (and thus the pill) only runs on a complete form. Sonilo takes a
   *  single prompt; simple mode drafts from the prompt; custom needs a
   *  caption plus lyrics (ace's lyrics are optional). */
  const formEffective = isSonilo
    ? hasPrompt
    : mode === "simple"
      ? hasPrompt
      : ecoId === "ace"
        ? hasCaption
        : hasCaption && hasLyrics;

  /** Identity-stable request snapshot — the whatif effect re-runs only when
   *  the FORM actually changes, not on unrelated renders. */
  const costRequest = useMemo(buildRequest, [buildRequest]);

  // Free whatif cost check — debounced; a failure here means submit would
  // fail too, so the footer surfaces it instead of the buzz number.
  useEffect(() => {
    if (configured !== true || !formEffective) {
      setCost(null);
      setCostError(false);
      return;
    }
    let cancelled = false;
    setCostError(false);
    const timer = setTimeout(() => {
      call<MusicCostView>("civitai_music_cost", { req: costRequest })
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
  }, [costRequest, configured, formEffective]);

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
          const st = await call<MusicStatusView>("civitai_music_status", {
            workflowId: job.workflowId,
            waitSecs: STATUS_WAIT_SECS,
          });
          if (cancelled || !aliveRef.current) return;
          setStatus(st);
          if (st.status === "succeeded" && st.audioUrl) {
            // Fetch exactly once — the signed URL expires after download.
            const saved = await call<SavedAudio>("civitai_music_fetch", {
              workflowId: job.workflowId,
              audioUrl: st.audioUrl,
            });
            if (cancelled || !aliveRef.current) return;
            const entry: MusicResultEntry = {
              fileId: saved.fileId,
              name: saved.name,
              prompt: job.prompt,
              ecosystem: ecoId,
              at: Date.now(),
              req: job.req,
            };
            setResults((prev) => {
              const next = [entry, ...prev].slice(0, MAX_RESULTS);
              localStorage.setItem(RESULTS_KEY, JSON.stringify(next));
              return next;
            });
            localStorage.removeItem(JOB_KEY);
            setJob(null);
            setStatus(null);
            toast.success(t("musicGenerator.done"));
            return;
          }
          if (TERMINAL_FAILED[st.status]) {
            localStorage.removeItem(JOB_KEY);
            setJob(null);
            toast.error(`${t("musicGenerator.failedToast")}: ${st.error ?? st.status}`);
            return;
          }
        } catch (e) {
          // Transport hiccup — brief pause and keep polling; the workflow
          // keeps running server-side and the job survives restarts.
          if (cancelled || !aliveRef.current) return;
          if (Date.now() - job.at > 30 * 60 * 1000) {
            localStorage.removeItem(JOB_KEY);
            setJob(null);
            toast.error(`${t("musicGenerator.failedToast")}: ${errText(e)}`);
            return;
          }
          await delay(4000);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [job, t, ecoId]);

  function pickCover(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error(t("musicGenerator.coverType"));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error(t("musicGenerator.coverTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setCoverImage(reader.result);
    };
    reader.readAsDataURL(file);
  }

  const canSubmit = configured === true && !submitting && !job && formEffective && !costError;

  async function handleGenerate() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      // Client pre-check (display-grade): skip the submit when the balance
      // obviously can't cover the quoted cost. An unreadable balance falls
      // through — the server-side debit inside the submit op is the
      // authoritative fail-closed gate.
      const required = cost?.totalTokens;
      if (required !== undefined) {
        const balance = await refreshTokenBalance();
        if (balance !== null && balance < required) {
          toast.error(t("generator.insufficientBalance", { tokens: required.toLocaleString("id-ID") }));
          setSubmitting(false);
          return;
        }
      }
      const submitted = buildRequest();
      const view = await call<{ workflowId: string }>("civitai_music_submit", { req: submitted });
      const nextJob: ActiveJob = {
        workflowId: view.workflowId,
        prompt: prompt.trim() || caption.trim(),
        at: Date.now(),
        req: stripMusicReq(submitted),
      };
      localStorage.setItem(JOB_KEY, JSON.stringify(nextJob));
      setStatus(null);
      setJob(nextJob);
    } catch (e) {
      toast.error(`${t("musicGenerator.failedToast")}: ${errText(e)}`);
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }

  /** Load a result's generating settings back into the form. The ecosystem
   *  switch resets every dependent pick, so each field is restored here
   *  directly instead of routing through `switchEcosystem`. Uploaded cover
   *  art is never kept with the result — ACE re-asks for it. */
  function reuseEntry(entry: MusicResultEntry) {
    const r = entry.req;
    if (!r) {
      setPrompt(entry.prompt);
      toast.success(t("generator.settingsReusedPromptOnly"));
      return;
    }
    const nextEco = (MUSIC_ECOSYSTEMS.find((e) => e.id === r.ecosystem) ?? MUSIC_ECOSYSTEMS[0]).id;
    const nextOp: MusicOperation = r.operation ?? "music";
    const nextRange = musicDurationRange(nextEco, nextOp);
    const nextMode = musicEcosystem(nextEco).modes.includes(r.mode ?? "simple")
      ? ((r.mode ?? "simple") as MusicMode)
      : musicEcosystem(nextEco).modes[0];
    setEcoId(nextEco);
    setMode(nextMode);
    setOperation(nextOp);
    setPrompt(r.prompt ?? "");
    setCaption(r.caption ?? "");
    setLyrics(r.lyrics ?? "");
    setAbc(r.abc ?? "");
    setScoreMode(r.scoreMode ?? "full");
    setSteps(r.steps != null ? String(r.steps) : "");
    setBpm(r.bpm != null ? String(r.bpm) : "");
    setInstrumentalWeight(r.instrumentalWeight != null ? String(r.instrumentalWeight) : "");
    setVocalWeight(r.vocalWeight != null ? String(r.vocalWeight) : "");
    setCfgScale(r.cfgScale != null ? String(r.cfgScale) : "");
    setVariant(r.model ?? "xl-turbo");
    setCoverImage(null);
    setDuration(Math.min(nextRange.max, Math.max(nextRange.min, r.duration ?? nextRange.default)));
    setSeed(r.seed != null ? String(r.seed) : "");
    setSeedMode(r.seed != null ? "custom" : "random");
    toast.success(t("generator.settingsReused"));
    if (r.hadCover) toast.info(t("generator.sourceNotRestored"));
  }

  /** Drop a track from the panel's log — the stored file itself stays in the
   *  office store, so deliverables keep resolving its token. */
  function removeEntry(entry: MusicResultEntry) {
    setResults((prev) => {
      const next = prev.filter((e) => e.fileId !== entry.fileId);
      localStorage.setItem(RESULTS_KEY, JSON.stringify(next));
      return next;
    });
    toast(t("generator.resultRemoved"), {
      action: {
        label: t("common.undo"),
        onClick: () => {
          setResults((prev) => {
            if (prev.some((e) => e.fileId === entry.fileId)) return prev;
            const next = [entry, ...prev].slice(0, MAX_RESULTS);
            localStorage.setItem(RESULTS_KEY, JSON.stringify(next));
            return next;
          });
        },
      },
    });
  }

  const ecoPicker = (
    <div
      className="bg-popover absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-[10px] border shadow-xl"
      role="listbox"
    >
      {MUSIC_ECOSYSTEMS.map((e) => {
        const selected = e.id === ecoId;
        return (
          <EcoOptionButton
            key={e.id}
            onPick={() => {
              setEcoOpen(false);
              if (!selected) switchEcosystem(e.id);
            }}
            selected={selected}
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
          </EcoOptionButton>
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
        onSwitchToVideo={onSwitchToVideo}
      >
        {ecoPicker}
      </MediaIsland>
      {ecoOpen && <div aria-hidden className="fixed inset-0 z-20" onClick={() => setEcoOpen(false)} />}
      <KeyStatusNotices configured={configured} />

      {/* Model — civitai's resource row: card art + model name (the audio
          ecosystems are all modelLocked — pinned server-side, nothing to
          swap). Art rides `civitai_model_covers` (v1 version records,
          worker-proxied URLs); no card → letter tile like the eco picker. */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-[13px] font-medium">{t("generator.model")}</Label>
        <div className="flex items-center gap-2.5 rounded-[10px] border p-2">
          {musicCover?.url ? (
            <img
              alt={musicCover.modelName ?? eco.model}
              className="size-10 shrink-0 rounded-[6px] border object-cover"
              src={musicCover.url}
            />
          ) : (
            <div
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-[6px] bg-gradient-to-br text-base font-bold text-white",
                eco.gradient,
              )}
            >
              {eco.label.charAt(0)}
            </div>
          )}
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-primary">{musicCover?.modelName ?? eco.model}</div>
            <div className="text-muted-foreground truncate text-[11px]">{eco.model}</div>
          </div>
        </div>
        {isAce && (
          <div className="flex flex-wrap gap-1.5">
            {ACE_VARIANTS.map((v) => (
              <button
                className={cn(choiceClassShared(variant === v.key))}
                key={v.key}
                onClick={() => {
                  if (variant === v.key) return;
                  setVariant(v.key);
                  setSteps("");
                  setCfgScale("");
                }}
                type="button"
              >
                {v.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Cover image — ACE only, both modes (civitai's optional cover upload;
          the generate-cover checkbox is skipped — kawai has no imageGen step). */}
      {isAce && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("musicGenerator.cover")}</Label>
          {coverImage ? (
            <div className="relative overflow-hidden rounded-[8px] border">
              <img
                alt={t("musicGenerator.cover")}
                className="aspect-video w-full bg-black object-cover"
                src={coverImage}
              />
              <Button
                aria-label={t("musicGenerator.clearCover")}
                className="absolute top-1 right-1 size-6"
                onClick={() => setCoverImage(null)}
                size="icon"
                variant="secondary"
              >
                <Icon className="size-3.5" name="x" />
              </Button>
            </div>
          ) : (
            <label className="text-muted-foreground flex h-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed text-xs transition-colors hover:text-foreground">
              <Icon className="size-5" name="image-plus" />
              {t("musicGenerator.pickCover")}
              <input
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => pickCover(e.target.files?.[0])}
                type="file"
              />
            </label>
          )}
          <p className="text-muted-foreground/70 text-[10px]">{t("musicGenerator.coverHint")}</p>
        </div>
      )}

      {/* Mode — simple (backend drafts caption/lyrics via LLM) or custom.
          Sonilo is custom-only. */}
      {eco.modes.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("musicGenerator.mode")}</Label>
          <div className="flex gap-2">
            {(["simple", "custom"] as MusicMode[]).map((m) => (
              <button
                className={cn(choiceClassShared(mode === m), "flex-1")}
                key={m}
                onClick={() => switchMode(m)}
                type="button"
              >
                {m === "simple" ? t("musicGenerator.simple") : t("musicGenerator.custom")}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Operation — sonilo only: music track vs sound effect. */}
      {isSonilo && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("musicGenerator.generate")}</Label>
          <div className="flex gap-2">
            {(["music", "soundEffect"] as MusicOperation[]).map((op) => (
              <button
                className={cn(choiceClassShared(operation === op), "flex-1")}
                key={op}
                onClick={() => switchOperation(op)}
                type="button"
              >
                {op === "music" ? t("musicGenerator.music") : t("musicGenerator.soundEffect")}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Prompt — simple mode input or sonilo's single prompt. */}
      {(mode === "simple" || isSonilo) && (
        <div className="flex flex-col gap-1.5">
          {/* civitai's PromptLabel: info tooltip + required asterisk. */}
          <div className="flex items-center gap-1">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-prompt">
              {t("generator.prompt")}
            </Label>
            {!isSonilo && (
              <span className="text-muted-foreground/70 cursor-help" title={t("musicGenerator.promptInfo")}>
                <Icon className="size-3.5" name="info" />
              </span>
            )}
            <span className="text-destructive">*</span>
          </div>
          <Textarea
            className="min-h-20 rounded-[8px]"
            id="music-prompt"
            maxLength={eco.promptMax}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={isSonilo ? t("generator.promptPlaceholder") : t("musicGenerator.promptPlaceholderSong")}
            value={prompt}
          />
        </div>
      )}

      {/* Custom — caption (style description). */}
      {isCustom && !isSonilo && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-caption">
            {t("musicGenerator.caption")}
          </Label>
          <Textarea
            className="min-h-16 rounded-[8px]"
            id="music-caption"
            maxLength={eco.promptMax}
            onChange={(e) => setCaption(e.target.value)}
            placeholder={t("musicGenerator.captionPlaceholder")}
            value={caption}
          />
          <p className="text-muted-foreground/70 text-[10px]">{t("musicGenerator.captionDesc")}</p>
        </div>
      )}

      {/* Custom — lyrics (minimax/yue2 required; ace optional). */}
      {isCustom && !isSonilo && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-lyrics">
            {t("musicGenerator.lyrics")}
            {ecoId === "ace" ? ` (${t("musicGenerator.optional")})` : ""}
          </Label>
          <Textarea
            className="min-h-24 rounded-[8px] font-mono text-xs"
            id="music-lyrics"
            onChange={(e) => setLyrics(e.target.value)}
            placeholder={t("musicGenerator.lyricsPlaceholder")}
            value={lyrics}
          />
          <p className="text-muted-foreground/70 text-[10px]">{t("musicGenerator.lyricsDesc")}</p>
        </div>
      )}

      {/* YuE2 — score planning + optional ABC textarea (hidden when off). */}
      {ecoId === "yue2" && isCustom && (
        <>
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1">
              <Label className="text-muted-foreground text-[13px] font-medium">
                {t("musicGenerator.scorePlanning")}
              </Label>
              <span className="text-muted-foreground/70 cursor-help" title={t("musicGenerator.scorePlanningInfo")}>
                <Icon className="size-3.5" name="info" />
              </span>
            </div>
            <div className="flex gap-2">
              {(["full", "melody", "off"] as MusicScoreMode[]).map((m) => (
                <button
                  className={cn(choiceClassShared(scoreMode === m), "flex-1")}
                  key={m}
                  onClick={() => setScoreMode(m)}
                  type="button"
                >
                  {t(`musicGenerator.score_${m}`)}
                </button>
              ))}
            </div>
          </div>
          {scoreMode !== "off" && (
            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-abc">
                {t("musicGenerator.abc")}
              </Label>
              <Textarea
                className="min-h-24 rounded-[8px] font-mono text-xs"
                id="music-abc"
                onChange={(e) => setAbc(e.target.value)}
                placeholder={t("musicGenerator.abcPlaceholder")}
                value={abc}
              />
              <p className="text-muted-foreground/70 text-[10px]">{t("musicGenerator.abcDesc")}</p>
            </div>
          )}
        </>
      )}

      {/* ACE custom — BPM → instrumental weight → vocal weight (civitai's
          graph order; step 0.1 weights). Key arrives via simple-mode draft. */}
      {isAce && isCustom && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-bpm">
              {t("musicGenerator.bpm")}
            </Label>
            <Slider
              id="music-bpm"
              max={200}
              min={40}
              onValueChange={(v) => setBpm(String(v[0]))}
              step={1}
              value={[Number(bpm) || 120]}
            >
              <SliderTrack>
                <SliderRange />
              </SliderTrack>
              <SliderThumb aria-label={t("musicGenerator.bpm")} />
            </Slider>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-instr">
              {t("musicGenerator.instrumentalWeight")}
            </Label>
            <Slider
              id="music-instr"
              max={1}
              min={0}
              onValueChange={(v) => setInstrumentalWeight(String(v[0]))}
              step={0.1}
              value={[Number(instrumentalWeight) || 0.5]}
            >
              <SliderTrack>
                <SliderRange />
              </SliderTrack>
              <SliderThumb aria-label={t("musicGenerator.instrumentalWeight")} />
            </Slider>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-vocal">
              {t("musicGenerator.vocalWeight")}
            </Label>
            <Slider
              id="music-vocal"
              max={1}
              min={0}
              onValueChange={(v) => setVocalWeight(String(v[0]))}
              step={0.1}
              value={[Number(vocalWeight) || 0.5]}
            >
              <SliderTrack>
                <SliderRange />
              </SliderTrack>
              <SliderThumb aria-label={t("musicGenerator.vocalWeight")} />
            </Slider>
          </div>
        </>
      )}

      {/* Duration — slider honoring per-engine/per-operation bounds; YuE2
          caps the track length, others set it outright. Civitai pairs the
          slider with a numeric stepper. */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-duration">
          {t(ecoId === "yue2" ? "musicGenerator.durationMax" : "musicGenerator.duration", { seconds: duration })}
        </Label>
        <div className="flex items-center gap-2">
          <Slider
            className="flex-1"
            id="music-duration"
            max={durRange.max}
            min={durRange.min}
            onValueChange={(v) => setDuration(v[0])}
            step={durStep}
            value={[duration]}
          >
            <SliderTrack>
              <SliderRange />
            </SliderTrack>
            <SliderThumb
              aria-label={t(ecoId === "yue2" ? "musicGenerator.durationMax" : "musicGenerator.duration", {
                seconds: duration,
              })}
            />
          </Slider>
          <div className="flex h-9 w-[4.5rem] shrink-0 items-center rounded-[8px] border">
            <input
              aria-label={t(ecoId === "yue2" ? "musicGenerator.durationMax" : "musicGenerator.duration", {
                seconds: duration,
              })}
              className="w-full min-w-0 bg-transparent px-2 text-center text-sm outline-none"
              inputMode="decimal"
              onBlur={(e) => {
                const parsed = Number(e.target.value);
                setDuration(
                  Number.isFinite(parsed) ? Math.min(durRange.max, Math.max(durRange.min, parsed)) : duration,
                );
                setDurText(null);
              }}
              onChange={(e) => {
                setDurText(e.target.value);
                const parsed = Number(e.target.value);
                if (Number.isFinite(parsed) && parsed >= durRange.min && parsed <= durRange.max) {
                  setDuration(parsed);
                }
              }}
              value={durText ?? String(duration)}
            />
            <div className="flex shrink-0 flex-col border-l">
              <button
                aria-label="+"
                className="text-muted-foreground hover:text-foreground flex h-4.5 w-6 items-center justify-center"
                onClick={() => {
                  setDurText(null);
                  setDuration((d) => Math.min(durRange.max, +(d + durStep).toFixed(2)));
                }}
                type="button"
              >
                <Icon className="size-3 rotate-180" name="chevron-down" />
              </button>
              <button
                aria-label="−"
                className="text-muted-foreground hover:text-foreground flex h-4.5 w-6 items-center justify-center border-t"
                onClick={() => {
                  setDurText(null);
                  setDuration((d) => Math.max(durRange.min, +(d - durStep).toFixed(2)));
                }}
                type="button"
              >
                <Icon className="size-3" name="chevron-down" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Advanced — CFG Scale (ace), Steps (yue2/ace), Seed (all but sonilo;
          civitai's sonilo graph carries none of these). */}
      {!isSonilo && (
        <Collapsible onOpenChange={setAdvancedOpen} open={advancedOpen}>
          <CollapsibleTrigger className="group text-muted-foreground flex items-center gap-1 text-[13px] font-medium">
            <Icon className="size-4 transition-transform group-data-[state=open]:rotate-180" name="chevron-down" />{" "}
            {t("generator.advanced")}
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-3 pt-2">
            {isAce && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-cfg">
                  {t("generator.cfgScale")}
                </Label>
                <Slider
                  id="music-cfg"
                  max={10}
                  min={0.5}
                  onValueChange={(v) => setCfgScale(String(v[0]))}
                  step={0.5}
                  value={[Number(cfgScale) || aceCfgDefault(variant)]}
                >
                  <SliderTrack>
                    <SliderRange />
                  </SliderTrack>
                  <SliderThumb aria-label={t("generator.cfgScale")} />
                </Slider>
              </div>
            )}
            {(ecoId === "yue2" || isAce) && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-steps">
                  {t("generator.steps")}
                </Label>
                <Slider
                  id="music-steps"
                  max={ecoId === "yue2" ? 100 : aceSteps.max}
                  min={ecoId === "yue2" ? 1 : aceSteps.min}
                  onValueChange={(v) => setSteps(String(v[0]))}
                  step={1}
                  value={[Number(steps) || (ecoId === "yue2" ? 32 : aceSteps.default)]}
                >
                  <SliderTrack>
                    <SliderRange />
                  </SliderTrack>
                  <SliderThumb aria-label={t("generator.steps")} />
                </Slider>
              </div>
            )}
            {!isSonilo && (
              <div className="flex flex-col gap-1.5">
                <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="music-seed">
                  {t("generator.seed")}
                </Label>
                <div className="flex items-center gap-2">
                  <div className="flex shrink-0 rounded-[8px] border p-0.5">
                    <button
                      className={cn(choiceClassShared(seedMode === "random"), "px-2.5 py-1")}
                      onClick={() => setSeedMode("random")}
                      type="button"
                    >
                      {t("generator.seedRandom")}
                    </button>
                    <button
                      className={cn(choiceClassShared(seedMode === "custom"), "px-2.5 py-1")}
                      onClick={() => setSeedMode("custom")}
                      type="button"
                    >
                      {t("musicGenerator.custom")}
                    </button>
                  </div>
                  <Input
                    className="h-8 flex-1 rounded-[8px]"
                    disabled={seedMode === "random"}
                    id="music-seed"
                    inputMode="numeric"
                    onChange={(e) => setSeed(e.target.value.replace(/[^0-9]/g, ""))}
                    placeholder={t("generator.seedRandom")}
                    value={seed}
                  />
                </div>
              </div>
            )}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );

  return (
    <AssetShell subtitle={t("musicGenerator.subtitle")} title={t("generator.title")} onBack={onBack}>
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
                  <span className="text-destructive text-[11px] leading-tight">{t("musicGenerator.costFailed")}</span>
                ) : cost ? (
                  <>
                    <Icon className="text-warning size-3.5" name="zap" />
                    <span className="text-warning text-[13px] font-semibold">
                      ≈{cost.totalTokens.toLocaleString("id-ID")}
                    </span>
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
                <JobCard
                  elapsed={elapsed}
                  job={job}
                  onCancel={() => {
                    const workflowId = job.workflowId;
                    // Cancel reuses the video op — same workflow bus.
                    void call("civitai_video_cancel", { workflowId })
                      .catch(() => undefined)
                      .finally(() => {
                        localStorage.removeItem(JOB_KEY);
                        setJob(null);
                        toast.success(t("videoGenerator.canceled"));
                      });
                  }}
                  status={status}
                />
              </div>
            )}
            {results.length === 0 && !job ? (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center">
                <Icon className="size-16 stroke-1" name="inbox" />
                <p className="text-foreground text-sm font-medium">{t("musicGenerator.noResults")}</p>
                <p className="max-w-56 text-xs">{t("musicGenerator.noResultsHint")}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {results.map((entry) => (
                  <MusicResultCard
                    entry={entry}
                    key={entry.fileId}
                    onRemove={() => removeEntry(entry)}
                    onReuse={() => reuseEntry(entry)}
                  />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </AssetShell>
  );
}
