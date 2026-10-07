import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { refreshTokenBalance } from "@/features/topup/use-token-balance";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  DEFAULT_MODEL3D_ECOSYSTEM,
  HUNYUAN_CFG,
  HUNYUAN_OCTREE,
  HUNYUAN_STEPS,
  MESHY_POLYCOUNT,
  MODEL3D_ECOSYSTEMS,
  TRIPO_FACE_LIMIT,
  type Model3dEcosystemConfig,
  type Model3dProcess,
  model3dEcosystem,
} from "./model3d-ecosystems";
import { KeyStatusNotices, useAliveEffect, useCivitaiKeyStatus } from "./civitai-shared";
import { GenerateFooter, publishMediaDebit } from "./generate-footer";
import { type PickerGroup, PickerMenu } from "./picker-menu";
import { ResultActions, mediaToken } from "./result-actions";
import { FrameSlot } from "./video-generator";

/** Civitai polyGen request the Rust ops accept (camelCase, flattened). */
interface Model3dGenRequest {
  ecosystem: string;
  process?: string;
  prompt?: string;
  image?: string;
  mode?: string;
  enablePromptExpansion?: boolean;
  targetPolycount?: number;
  topology?: string;
  symmetryMode?: string;
  shouldTexture?: boolean;
  shouldRemesh?: boolean;
  enablePbr?: boolean;
  texturePrompt?: string;
  enableRigging?: boolean;
  enableAnimation?: boolean;
  texture?: string;
  quad?: boolean;
  autoSize?: boolean;
  faceLimit?: number;
  textureAlignment?: string;
  orientation?: string;
  textureSeed?: number;
  modelVersion?: string;
  steps?: number;
  cfgScale?: number;
  octreeResolution?: number;
  seed?: number;
  withPreview?: boolean;
}

interface Model3dCostView {
  totalBuzz: number;
  totalTokens: number;
  ready: boolean;
  warnings: string[];
}

interface Model3dBlobView {
  url: string;
  format?: string;
}

interface Model3dStatusView {
  workflowId: string;
  status: string;
  queuePosition: number | null;
  model?: Model3dBlobView;
  fbx?: Model3dBlobView;
  previewUrl?: string;
  extras: Array<Model3dBlobView & { variant: string }>;
  error?: string;
}

interface SavedModel3d {
  fileId: string;
  name: string;
  fbxFileId?: string;
  previewFileId?: string;
  additional?: Array<{ fileId: string; name: string; variant: string }>;
}

interface Model3dResultEntry {
  fileId: string;
  name: string;
  previewFileId?: string;
  prompt: string;
  at: number;
  /** Generating settings for the card's "Load these settings" action.
   *  Absent on entries logged before snapshots existed. The source image is
   *  never kept (a data URL has no business in localStorage) — `hadMedia`
   *  records that the run consumed one. */
  req?: Omit<Model3dGenRequest, "image"> & { hadMedia?: boolean };
}

/** In-flight workflow, persisted so a restart resumes polling. */
interface ActiveJob {
  workflowId: string;
  prompt: string;
  at: number;
  req?: Omit<Model3dGenRequest, "image">;
}

const RESULTS_KEY = "kawai-generator-model3d-results-v1";
const JOB_KEY = "kawai-generator-model3d-job-v1";
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

/** The `Model3dGenRequest` behind a result, minus the uploaded media — a
 *  base64 image has no business in localStorage, and the slot is re-picked
 *  by hand anyway. `hadMedia` records that the run consumed one. */
function stripReq(req: Model3dGenRequest): Omit<Model3dGenRequest, "image"> & { hadMedia?: boolean } {
  const { image, ...rest } = req;
  return image ? { ...rest, hadMedia: true } : rest;
}

function choiceClass(active: boolean): string {
  return cn(
    "h-8 rounded-[8px] border text-xs font-medium transition-colors",
    active
      ? "border-primary/60 bg-primary/10 text-primary"
      : "bg-secondary text-muted-foreground hover:text-foreground",
  );
}

/** Civitai's [media tabs …… Eco | <ecosystem>] strip — 3D lane active; the
 *  other tabs hand control back to their panels. */
function MediaIsland({
  ecoGroups,
  ecoLabel,
  ecoOpen,
  onEcoOpenChange,
  onSwitchToImage,
  onSwitchToVideo,
  onSwitchToMusic,
}: {
  ecoGroups: PickerGroup[];
  ecoLabel: string;
  ecoOpen: boolean;
  onEcoOpenChange: (open: boolean) => void;
  onSwitchToImage: () => void;
  onSwitchToVideo: () => void;
  onSwitchToMusic: () => void;
}) {
  const { t } = useI18n();
  return (
    <div className="flex items-center justify-between gap-2 rounded-[10px] border p-1.5">
      <div className={SEGMENTED_LIST}>
        <button className={segmentClass(false)} onClick={onSwitchToImage} title="Image" type="button">
          <Icon className="size-4" name="image" />
        </button>
        <button className={segmentClass(false)} onClick={onSwitchToVideo} title="Video" type="button">
          <Icon className="size-4" name="video" />
        </button>
        <button className={segmentClass(false)} onClick={onSwitchToMusic} title="Music" type="button">
          <Icon className="size-4" name="music" />
        </button>
        <span className={cn(segmentClass(true), "pointer-events-none")} title="3D">
          <Icon className="size-4" name="box" />
        </span>
      </div>
      <PickerMenu
        ariaLabel={t("model3dGenerator.ecosystem")}
        groups={ecoGroups}
        onOpenChange={onEcoOpenChange}
        open={ecoOpen}
        trigger={
          <>
            <span className="text-muted-foreground">Eco</span>
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

/** One saved 3D result: the model3DPreview render as the tile — the GLB
 *  itself has no in-app viewer (deliberate: no three.js dependency), so the
 *  click-to-preview opens the controllable PNG render instead. */
function Model3dResultCard({
  entry,
  onRemove,
  onReuse,
}: {
  entry: Model3dResultEntry;
  onRemove: () => void;
  onReuse: () => void;
}) {
  const { t } = useI18n();
  const preview = useFilePreview(
    entry.previewFileId ? { id: entry.previewFileId, name: `${entry.name}-preview.png` } : { id: "", name: "" },
  );
  // The preview overlay picks its renderer from the NAME, so the name must
  // match the file actually opened: the .png render when present, the .glb
  // (unknown kind → download fallback) otherwise.
  const previewName = entry.previewFileId ? `${entry.name}-preview.png` : entry.name;
  const openPreviewId = entry.previewFileId ?? entry.fileId;
  return (
    <div className="group relative overflow-hidden rounded-[8px] border bg-secondary">
      <button
        className="block w-full cursor-zoom-in"
        onClick={() => emitOpenPreview(openPreviewId, previewName)}
        title={entry.prompt}
        type="button"
      >
        <div className="relative flex aspect-square w-full items-center justify-center bg-black">
          {preview.isLoading ? (
            <Spinner className="size-5 text-white" />
          ) : preview.data?.dataUrl ? (
            <img alt={entry.prompt} className="h-full w-full object-contain" src={preview.data.dataUrl} />
          ) : (
            <span className="flex flex-col items-center gap-1 text-muted-foreground">
              <Icon className="size-8 stroke-1" name="box" />
              <span className="text-xs">{t("model3dGenerator.posterMissing")}</span>
            </span>
          )}
        </div>
      </button>
      <ResultActions
        fileId={entry.fileId}
        fileName={entry.name}
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
  status: Model3dStatusView | null;
  elapsed: number;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const statusKey =
    status?.status === "processing"
      ? "model3dGenerator.processing"
      : status?.status === "succeeded"
        ? "model3dGenerator.succeeded"
        : "model3dGenerator.queued";
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
          {t("model3dGenerator.position", { position: status.queuePosition })}
        </p>
      )}
      {status?.error && <p className="text-destructive text-xs">{status.error}</p>}
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground/60 truncate font-mono text-[10px]">{job.workflowId}</p>
        <Button className="h-7 shrink-0 rounded-[6px] px-2 text-xs" onClick={onCancel} size="sm" variant="secondary">
          {t("model3dGenerator.cancel")}
        </Button>
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  onCheckedChange,
  checked,
}: {
  label: string;
  onCheckedChange: (v: boolean) => void;
  checked: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between gap-2 text-[13px]">
      <span className="text-muted-foreground font-medium">{label}</span>
      <input
        checked={checked}
        className="accent-primary size-4"
        onChange={(e) => onCheckedChange(e.target.checked)}
        type="checkbox"
      />
    </label>
  );
}

export function Model3dGenerator({
  onBack,
  onSwitchToImage,
  onSwitchToVideo,
  onSwitchToMusic,
}: {
  onBack: () => void;
  onSwitchToImage: () => void;
  onSwitchToVideo: () => void;
  onSwitchToMusic: () => void;
}) {
  const { t } = useI18n();
  const configured = useCivitaiKeyStatus();
  const [ecoId, setEcoId] = useState<Model3dEcosystemConfig["id"]>(DEFAULT_MODEL3D_ECOSYSTEM);
  const eco = model3dEcosystem(ecoId);
  const [process, setProcess] = useState<Model3dProcess>("textTo3D");
  const [prompt, setPrompt] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [mode, setMode] = useState("full");
  const [promptExpansion, setPromptExpansion] = useState(false);
  const [polycount, setPolycount] = useState(MESHY_POLYCOUNT.default);
  const [topology, setTopology] = useState("triangle");
  const [symmetry, setSymmetry] = useState("auto");
  const [texturePrompt, setTexturePrompt] = useState("");
  const [animate, setAnimate] = useState(false);
  const [shouldTexture, setShouldTexture] = useState(true);
  const [shouldRemesh, setShouldRemesh] = useState(true);
  const [pbr, setPbr] = useState(false);
  const [tripoTexture, setTripoTexture] = useState("standard");
  const [quad, setQuad] = useState(false);
  const [autoSize, setAutoSize] = useState(false);
  const [faceLimit, setFaceLimit] = useState(TRIPO_FACE_LIMIT.default);
  const [textureAlignment, setTextureAlignment] = useState("original_image");
  const [orientation, setOrientation] = useState("default");
  const [textureSeed, setTextureSeed] = useState("");
  const [modelVersion, setModelVersion] = useState("v2.1");
  const [hunyuanSteps, setHunyuanSteps] = useState(HUNYUAN_STEPS.default);
  const [hunyuanCfg, setHunyuanCfg] = useState(HUNYUAN_CFG.default);
  const [octree, setOctree] = useState(HUNYUAN_OCTREE.default);
  const [seed, setSeed] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [ecoOpen, setEcoOpen] = useState(false);
  const [cost, setCost] = useState<Model3dCostView | null>(null);
  const [costError, setCostError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<ActiveJob | null>(() => loadJson<ActiveJob | null>(JOB_KEY, null));
  const [status, setStatus] = useState<Model3dStatusView | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<Model3dResultEntry[]>(() => loadJson<Model3dResultEntry[]>(RESULTS_KEY, []));
  const aliveRef = useRef(true);
  useAliveEffect(aliveRef);

  const isMeshy = ecoId === "meshy";
  const isTripo = ecoId === "tripo";
  const isHunyuan = ecoId === "hunyuan3d";
  const isTxt = isMeshy && process === "textTo3D";
  const needsImage = !isTxt;

  /** Ecosystem/process switches reset the dependent picks to each engine's
   *  defaults — a stale pick would fail the whatif. */
  const reinitPicks = useCallback((nextProcess: Model3dProcess) => {
    setProcess(nextProcess);
    setPrompt("");
    setImage(null);
    setMode("full");
    setPromptExpansion(false);
    setPolycount(MESHY_POLYCOUNT.default);
    setTopology("triangle");
    setSymmetry("auto");
    setTexturePrompt("");
    setAnimate(false);
    setShouldTexture(true);
    setShouldRemesh(true);
    setPbr(false);
    setTripoTexture("standard");
    setQuad(false);
    setAutoSize(false);
    setFaceLimit(TRIPO_FACE_LIMIT.default);
    setTextureAlignment("original_image");
    setOrientation("default");
    setTextureSeed("");
    setModelVersion("v2.1");
    setHunyuanSteps(HUNYUAN_STEPS.default);
    setHunyuanCfg(HUNYUAN_CFG.default);
    setOctree(HUNYUAN_OCTREE.default);
    setSeed("");
  }, []);

  const switchEcosystem = useCallback(
    (id: Model3dEcosystemConfig["id"]) => {
      setEcoId(id);
      const next = model3dEcosystem(id);
      reinitPicks(next.processes[0]);
    },
    [reinitPicks],
  );

  const buildRequest = useCallback((): Model3dGenRequest => {
    const num = (s: string) => (s.trim() ? Number(s) : undefined);
    const req: Model3dGenRequest = {
      ecosystem: ecoId,
      process: isMeshy ? process : undefined,
      prompt: prompt.trim() || undefined,
      image: needsImage && image ? image : undefined,
      seed: num(seed),
      withPreview: true,
    };
    if (isMeshy) {
      if (isTxt) {
        req.mode = mode;
        req.enablePromptExpansion = promptExpansion || undefined;
      } else {
        req.shouldTexture = shouldTexture;
      }
      req.targetPolycount = polycount;
      req.topology = topology;
      req.symmetryMode = symmetry;
      req.shouldRemesh = shouldRemesh;
      req.enablePbr = pbr;
      req.texturePrompt = texturePrompt.trim() || undefined;
      req.enableAnimation = animate || undefined;
      req.enableRigging = animate || undefined;
    }
    if (isTripo) {
      req.texture = tripoTexture;
      req.enablePbr = pbr;
      req.quad = quad || undefined;
      req.autoSize = autoSize || undefined;
      req.faceLimit = faceLimit;
      req.textureAlignment = textureAlignment;
      req.orientation = orientation;
      req.textureSeed = num(textureSeed);
    }
    if (!isMeshy && !isTripo) {
      // The comfy trellis2 family (trellis2 / pixal3d / hunyuan3d).
      req.shouldTexture = shouldTexture;
      req.shouldRemesh = shouldRemesh;
      req.enablePbr = pbr;
    }
    if (isHunyuan) {
      req.modelVersion = modelVersion;
      req.steps = hunyuanSteps;
      req.cfgScale = hunyuanCfg;
      req.octreeResolution = octree;
    }
    return req;
  }, [
    animate,
    autoSize,
    ecoId,
    faceLimit,
    hunyuanCfg,
    hunyuanSteps,
    image,
    isHunyuan,
    isMeshy,
    isTxt,
    isTripo,
    mode,
    modelVersion,
    needsImage,
    octree,
    orientation,
    pbr,
    polycount,
    process,
    prompt,
    promptExpansion,
    quad,
    seed,
    shouldRemesh,
    shouldTexture,
    symmetry,
    textureAlignment,
    texturePrompt,
    textureSeed,
    topology,
    tripoTexture,
  ]);

  /** Identity-stable request snapshot — the whatif effect re-runs only when
   *  the FORM actually changes, not on unrelated renders. */
  const costRequest = useMemo(buildRequest, [buildRequest]);

  const formReady = isTxt ? prompt.trim().length > 0 : image != null;

  // Free whatif cost check — debounced; a failure here means submit would
  // fail too, so the footer surfaces it instead of the buzz number.
  useEffect(() => {
    if (configured !== true || !formReady) {
      setCost(null);
      setCostError(false);
      return;
    }
    let cancelled = false;
    setCostError(false);
    const timer = setTimeout(() => {
      call<Model3dCostView>("civitai_model3d_cost", { req: costRequest })
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
  }, [costRequest, configured, formReady]);

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
          const st = await call<Model3dStatusView>("civitai_model3d_status", {
            workflowId: job.workflowId,
            waitSecs: STATUS_WAIT_SECS,
          });
          if (cancelled || !aliveRef.current) return;
          setStatus(st);
          if (st.status === "succeeded" && st.model) {
            const saved = await call<SavedModel3d>("civitai_model3d_fetch", {
              workflowId: job.workflowId,
              modelUrl: st.model.url,
              modelFormat: st.model.format,
              fbxUrl: st.fbx?.url,
              fbxFormat: st.fbx?.format,
              previewUrl: st.previewUrl,
              extraUrls: st.extras ?? [],
            });
            if (cancelled || !aliveRef.current) return;
            const entry: Model3dResultEntry = {
              fileId: saved.fileId,
              name: saved.name,
              previewFileId: saved.previewFileId,
              prompt: job.prompt,
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
            toast.success(t("model3dGenerator.done"));
            return;
          }
          if (TERMINAL_FAILED[st.status]) {
            localStorage.removeItem(JOB_KEY);
            setJob(null);
            toast.error(`${t("model3dGenerator.failedToast")}: ${st.error ?? st.status}`);
            return;
          }
        } catch (e) {
          // Transport hiccup — brief pause and keep polling; the workflow
          // keeps running server-side and the job survives restarts.
          if (cancelled || !aliveRef.current) return;
          if (Date.now() - job.at > 60 * 60 * 1000) {
            localStorage.removeItem(JOB_KEY);
            setJob(null);
            toast.error(`${t("model3dGenerator.failedToast")}: ${errText(e)}`);
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

  function pickImage(file: File | undefined) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error(t("model3dGenerator.sourceTooLarge"));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") setImage(reader.result);
    };
    reader.readAsDataURL(file);
  }

  const canSubmit = configured === true && !submitting && !job && formReady;

  async function handleGenerate() {
    if (!canSubmit || !formReady) return;
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
      const view = await call<{ workflowId: string }>("civitai_model3d_submit", { req: submitted });
      publishMediaDebit(cost?.totalTokens ?? 0);
      const nextJob: ActiveJob = {
        workflowId: view.workflowId,
        prompt: prompt.trim(),
        at: Date.now(),
        req: stripReq(submitted),
      };
      localStorage.setItem(JOB_KEY, JSON.stringify(nextJob));
      setStatus(null);
      setJob(nextJob);
    } catch (e) {
      toast.error(`${t("model3dGenerator.failedToast")}: ${errText(e)}`);
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }

  /** Load a result's generating settings back into the form. The source
   *  image is never kept with the result, so image-to-3D re-asks for it. */
  function reuseEntry(entry: Model3dResultEntry) {
    const r = entry.req;
    if (!r) {
      setPrompt(entry.prompt);
      toast.success(t("generator.settingsReusedPromptOnly"));
      return;
    }
    const nextEco = model3dEcosystem(r.ecosystem).id === r.ecosystem ? r.ecosystem : DEFAULT_MODEL3D_ECOSYSTEM;
    const nextConfig = model3dEcosystem(nextEco);
    setEcoId(nextEco);
    const nextProcess = nextConfig.processes.includes(r.process as Model3dProcess)
      ? (r.process as Model3dProcess)
      : nextConfig.processes[0];
    reinitPicks(nextProcess);
    setPrompt(r.prompt ?? "");
    setImage(null);
    if (r.mode) setMode(r.mode);
    if (r.enablePromptExpansion != null) setPromptExpansion(r.enablePromptExpansion);
    if (r.targetPolycount != null) setPolycount(r.targetPolycount);
    if (r.topology) setTopology(r.topology);
    if (r.symmetryMode) setSymmetry(r.symmetryMode);
    if (r.texturePrompt) setTexturePrompt(r.texturePrompt);
    if (r.enableAnimation != null) setAnimate(r.enableAnimation);
    if (r.shouldTexture != null) setShouldTexture(r.shouldTexture);
    if (r.shouldRemesh != null) setShouldRemesh(r.shouldRemesh);
    if (r.enablePbr != null) setPbr(r.enablePbr);
    if (r.texture) setTripoTexture(r.texture);
    if (r.quad != null) setQuad(r.quad);
    if (r.autoSize != null) setAutoSize(r.autoSize);
    if (r.faceLimit != null) setFaceLimit(r.faceLimit);
    if (r.textureAlignment) setTextureAlignment(r.textureAlignment);
    if (r.orientation) setOrientation(r.orientation);
    if (r.textureSeed != null) setTextureSeed(String(r.textureSeed));
    if (r.modelVersion) setModelVersion(r.modelVersion);
    if (r.steps != null) setHunyuanSteps(r.steps);
    if (r.cfgScale != null) setHunyuanCfg(r.cfgScale);
    if (r.octreeResolution != null) setOctree(r.octreeResolution);
    setSeed(r.seed != null ? String(r.seed) : "");
    toast.success(t("generator.settingsReused"));
    if (r.hadMedia) toast.info(t("generator.sourceNotRestored"));
  }

  /** Drop an entry from the panel's log — the stored file itself stays in
   *  the office store, so deliverables keep resolving its token. */
  function removeEntry(entry: Model3dResultEntry) {
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

  /** The ecosystem menu: every engine with its one-line note. */
  const ecoGroups = useMemo<PickerGroup[]>(
    () => [
      {
        id: "ecosystems",
        items: MODEL3D_ECOSYSTEMS.map((e) => ({
          id: e.id,
          label: e.label,
          note: e.note,
          selected: e.id === ecoId,
          onSelect: () => {
            setEcoOpen(false);
            if (e.id !== ecoId) switchEcosystem(e.id);
          },
          tile: (
            <div
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-[6px] bg-gradient-to-br text-sm font-bold text-white",
                e.gradient,
              )}
            >
              {e.label.charAt(0)}
            </div>
          ),
        })),
      },
    ],
    [ecoId, switchEcosystem],
  );

  const advanced = (
    <div className="flex flex-col gap-3">
      {isMeshy && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="m3d-polycount">
              {t("model3dGenerator.polycount", { count: polycount.toLocaleString("en-US") })}
            </Label>
            <Slider
              id="m3d-polycount"
              max={MESHY_POLYCOUNT.max}
              min={MESHY_POLYCOUNT.min}
              onValueChange={(v) => setPolycount(v[0])}
              step={MESHY_POLYCOUNT.step}
              value={[polycount]}
            >
              <SliderTrack>
                <SliderRange />
              </SliderTrack>
              <SliderThumb aria-label={t("model3dGenerator.polycount", { count: polycount })} />
            </Slider>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.topology")}</Label>
            <div className="flex gap-1.5">
              {(["triangle", "quad"] as const).map((top) => (
                <button
                  className={cn(choiceClass(topology === top), "flex-1")}
                  key={top}
                  onClick={() => setTopology(top)}
                  type="button"
                >
                  {t(`model3dGenerator.topology_${top}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.symmetry")}</Label>
            <div className="flex gap-1.5">
              {(["auto", "on", "off"] as const).map((s) => (
                <button
                  className={cn(choiceClass(symmetry === s), "flex-1")}
                  key={s}
                  onClick={() => setSymmetry(s)}
                  type="button"
                >
                  {t(`model3dGenerator.symmetry_${s}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="m3d-texture-prompt">
              {t("model3dGenerator.texturePrompt")}
            </Label>
            <Input
              className="h-8 rounded-[8px]"
              id="m3d-texture-prompt"
              maxLength={600}
              onChange={(e) => setTexturePrompt(e.target.value)}
              placeholder={t("model3dGenerator.texturePromptPlaceholder")}
              value={texturePrompt}
            />
          </div>
          <ToggleRow
            checked={shouldRemesh}
            label={t("model3dGenerator.shouldRemesh")}
            onCheckedChange={setShouldRemesh}
          />
          <ToggleRow checked={pbr} label={t("model3dGenerator.pbr")} onCheckedChange={setPbr} />
          <ToggleRow checked={animate} label={t("model3dGenerator.animate")} onCheckedChange={setAnimate} />
        </>
      )}
      {isTripo && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="m3d-facelimit">
              {t("model3dGenerator.faceLimit", { count: faceLimit.toLocaleString("en-US") })}
            </Label>
            <Slider
              id="m3d-facelimit"
              max={TRIPO_FACE_LIMIT.max}
              min={TRIPO_FACE_LIMIT.min}
              onValueChange={(v) => setFaceLimit(v[0])}
              step={TRIPO_FACE_LIMIT.step}
              value={[faceLimit]}
            >
              <SliderTrack>
                <SliderRange />
              </SliderTrack>
              <SliderThumb aria-label={t("model3dGenerator.faceLimit", { count: faceLimit })} />
            </Slider>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium">
              {t("model3dGenerator.textureAlignment")}
            </Label>
            <div className="flex gap-1.5">
              {(["original_image", "geometry"] as const).map((a) => (
                <button
                  className={cn(choiceClass(textureAlignment === a), "flex-1")}
                  key={a}
                  onClick={() => setTextureAlignment(a)}
                  type="button"
                >
                  {t(`model3dGenerator.align_${a}`)}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.orientation")}</Label>
            <div className="flex gap-1.5">
              {(["default", "align_image"] as const).map((o) => (
                <button
                  className={cn(choiceClass(orientation === o), "flex-1")}
                  key={o}
                  onClick={() => setOrientation(o)}
                  type="button"
                >
                  {t(`model3dGenerator.orient_${o}`)}
                </button>
              ))}
            </div>
          </div>
          <ToggleRow checked={quad} label={t("model3dGenerator.quad")} onCheckedChange={setQuad} />
          <ToggleRow checked={autoSize} label={t("model3dGenerator.autoSize")} onCheckedChange={setAutoSize} />
          <ToggleRow checked={pbr} label={t("model3dGenerator.pbr")} onCheckedChange={setPbr} />
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="m3d-texture-seed">
              {t("model3dGenerator.textureSeed")}
            </Label>
            <Input
              className="h-8 rounded-[8px]"
              id="m3d-texture-seed"
              inputMode="numeric"
              onChange={(e) => setTextureSeed(e.target.value)}
              placeholder={t("generator.seedRandom")}
              value={textureSeed}
            />
          </div>
        </>
      )}
      {!isMeshy && !isTripo && (
        <>
          <ToggleRow
            checked={shouldTexture}
            label={t("model3dGenerator.shouldTexture")}
            onCheckedChange={setShouldTexture}
          />
          <ToggleRow
            checked={shouldRemesh}
            label={t("model3dGenerator.shouldRemesh")}
            onCheckedChange={setShouldRemesh}
          />
          <ToggleRow checked={pbr} label={t("model3dGenerator.pbr")} onCheckedChange={setPbr} />
        </>
      )}
      {isHunyuan && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="m3d-hy-steps">
              {t("generator.steps")}
            </Label>
            <Slider
              id="m3d-hy-steps"
              max={HUNYUAN_STEPS.max}
              min={HUNYUAN_STEPS.min}
              onValueChange={(v) => setHunyuanSteps(v[0])}
              step={1}
              value={[hunyuanSteps]}
            >
              <SliderTrack>
                <SliderRange />
              </SliderTrack>
              <SliderThumb aria-label={t("generator.steps")} />
            </Slider>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="m3d-hy-cfg">
              {t("generator.cfgScale")}
            </Label>
            <Slider
              id="m3d-hy-cfg"
              max={HUNYUAN_CFG.max}
              min={HUNYUAN_CFG.min}
              onValueChange={(v) => setHunyuanCfg(v[0])}
              step={HUNYUAN_CFG.step}
              value={[hunyuanCfg]}
            >
              <SliderTrack>
                <SliderRange />
              </SliderTrack>
              <SliderThumb aria-label={t("generator.cfgScale")} />
            </Slider>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="m3d-hy-octree">
              {t("model3dGenerator.octree")}
            </Label>
            <Slider
              id="m3d-hy-octree"
              max={HUNYUAN_OCTREE.max}
              min={HUNYUAN_OCTREE.min}
              onValueChange={(v) => setOctree(v[0])}
              step={HUNYUAN_OCTREE.step}
              value={[octree]}
            >
              <SliderTrack>
                <SliderRange />
              </SliderTrack>
              <SliderThumb aria-label={t("model3dGenerator.octree")} />
            </Slider>
          </div>
        </>
      )}
      <div className="flex flex-col gap-1.5">
        <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="m3d-seed">
          {t("generator.seed")}
        </Label>
        <Input
          className="h-8 rounded-[8px]"
          id="m3d-seed"
          inputMode="numeric"
          onChange={(e) => setSeed(e.target.value)}
          placeholder={t("generator.seedRandom")}
          value={seed}
        />
      </div>
    </div>
  );

  const form = (
    <div className="flex flex-col gap-3 p-3">
      <MediaIsland
        ecoGroups={ecoGroups}
        ecoLabel={eco.label}
        ecoOpen={ecoOpen}
        onEcoOpenChange={setEcoOpen}
        onSwitchToImage={onSwitchToImage}
        onSwitchToVideo={onSwitchToVideo}
        onSwitchToMusic={onSwitchToMusic}
      />
      <KeyStatusNotices configured={configured} />

      {/* Process — meshy only (every other engine is image-to-3D). */}
      {isMeshy && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.process")}</Label>
          <div className="flex gap-2">
            {eco.processes.map((p) => (
              <button
                className={cn(choiceClass(process === p), "flex-1")}
                key={p}
                onClick={() => {
                  setProcess(p);
                  setImage(null);
                }}
                type="button"
              >
                {t(p === "textTo3D" ? "model3dGenerator.txt2_3d" : "model3dGenerator.img2_3d")}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Model version — hunyuan only. */}
      {isHunyuan && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("generator.model")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {eco.models.map((m) => (
              <button
                className={cn(choiceClass(modelVersion === m.key), "px-3")}
                key={m.key}
                onClick={() => setModelVersion(m.key)}
                type="button"
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Prompt — meshy textTo3D (required) / hunyuan texture hint. */}
      {(isTxt || isHunyuan) && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="m3d-prompt">
            {t("generator.prompt")}
          </Label>
          <Textarea
            className="min-h-20 rounded-[8px]"
            id="m3d-prompt"
            maxLength={eco.promptMax || undefined}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={
              isHunyuan ? t("model3dGenerator.promptHintPlaceholder") : t("model3dGenerator.promptPlaceholder")
            }
            value={prompt}
          />
        </div>
      )}

      {/* Source image — every imageTo3D process. */}
      {needsImage && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.sourceImage")}</Label>
          <FrameSlot
            caption={t("model3dGenerator.pickImage")}
            dataUrl={image ?? ""}
            onClear={() => setImage(null)}
            onPick={pickImage}
          />
        </div>
      )}

      {/* meshy textTo3D mode — preview drafts fast, full is production. */}
      {isTxt && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.mode")}</Label>
          <div className="flex gap-1.5">
            {(["preview", "full"] as const).map((m) => (
              <button
                className={cn(choiceClass(mode === m), "flex-1")}
                key={m}
                onClick={() => setMode(m)}
                type="button"
              >
                {t(`model3dGenerator.mode_${m}`)}
              </button>
            ))}
          </div>
          <ToggleRow
            checked={promptExpansion}
            label={t("model3dGenerator.promptExpansion")}
            onCheckedChange={setPromptExpansion}
          />
        </div>
      )}

      {/* tripo texture quality. */}
      {isTripo && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.texture")}</Label>
          <div className="flex gap-1.5">
            {(["no", "standard", "HD"] as const).map((tx) => (
              <button
                className={cn(choiceClass(tripoTexture === tx), "flex-1")}
                key={tx}
                onClick={() => setTripoTexture(tx)}
                type="button"
              >
                {t(`model3dGenerator.texture_${tx}`)}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Advanced */}
      <Collapsible onOpenChange={setAdvancedOpen} open={advancedOpen}>
        <CollapsibleTrigger className="group text-muted-foreground flex items-center gap-1 text-[13px] font-medium">
          <Icon className="size-4 transition-transform group-data-[state=open]:rotate-180" name="chevron-down" />{" "}
          {t("generator.advanced")}
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pt-2">{advanced}</CollapsibleContent>
      </Collapsible>
    </div>
  );

  return (
    <AssetShell subtitle={t("model3dGenerator.subtitle")} title={t("generator.title")} onBack={onBack}>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ── Form column — the generation panel ── */}
        <section className="bg-card flex w-full shrink-0 flex-col border-b lg:w-[400px] lg:border-r lg:border-b-0">
          <div className="min-h-0 flex-1 overflow-y-auto pb-24 overscroll-auto lg:overscroll-contain lg:pb-0">
            {form}
          </div>
          <GenerateFooter
            canSubmit={canSubmit}
            inFlight={job != null}
            inFlightLabel={t("model3dGenerator.inProgress")}
            note={t("model3dGenerator.costNote")}
            onSubmit={() => void handleGenerate()}
            quote={cost?.totalTokens ?? null}
            quoteState={costError ? "failed" : cost ? "quoted" : formReady && configured === true ? "pending" : "idle"}
            ready={cost?.ready ?? true}
            submitting={submitting}
            submittingLabel={t("generator.generatingElapsed", { seconds: elapsed })}
            submitLabel={t("generator.generate")}
            warnings={cost?.warnings ?? []}
          />
        </section>

        {/* ── Results pane ── */}
        <section className="flex min-h-[60vh] min-w-0 flex-1 flex-col border-t lg:min-h-0 lg:border-t-0">
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <span className="text-sm font-semibold">{t("generator.results")}</span>
            <span className="text-muted-foreground truncate text-[11px]">
              {t("generator.resultsCount", { count: results.length })}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-auto p-3 pb-24 lg:overscroll-contain lg:pb-3">
            {job && (
              <div className="mb-3">
                {
                  <JobCard
                    elapsed={elapsed}
                    job={job}
                    status={status}
                    onCancel={() => void call("civitai_video_cancel", { workflowId: job.workflowId })}
                  />
                }
              </div>
            )}
            {results.length === 0 ? (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center">
                <Icon className="size-16 stroke-1" name="inbox" />
                <p className="text-foreground text-sm font-medium">{t("model3dGenerator.noResults")}</p>
                <p className="max-w-56 text-xs">{t("model3dGenerator.noResultsHint")}</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {results.map((entry) => (
                  <Model3dResultCard
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
