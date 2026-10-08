import { useCallback, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/shared/icon";
import { call } from "@/lib/api";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { useFilePreview } from "@/lib/preview-file";
import { useI18n } from "@/hooks/use-i18n";
import { MODEL3D_NO_PROMPT, MODEL3D_STARTERS, type Model3dStarter } from "./model3d-starters";
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
import {
  KeyStatusNotices,
  type GenerationJobRow,
  laneStatusKey,
  type LaneResultEntry,
  type LaneStatusView,
  readFileAsDataUrl,
  useCivitaiKeyStatus,
  useEcoGroups,
  useWorkflowLane,
} from "./civitai-shared";
import { GenerateFooter } from "./generate-footer";
import { ResultActions, mediaToken } from "./result-actions";
import { FrameSlot } from "./video-generator";
import {
  ChoiceChip,
  detailLine,
  EcoPicker,
  GeneratorLayout,
  JobCard,
  resultMeta,
  ResultsPaneHeader,
  ToggleRow,
} from "./generator-shell";

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

interface Model3dBlobView {
  url: string;
  format?: string;
}

interface Model3dStatusView extends LaneStatusView {
  model?: Model3dBlobView;
  fbx?: Model3dBlobView;
  previewUrl?: string;
  extras: Array<Model3dBlobView & { variant: string }>;
}

interface SavedModel3d {
  fileId: string;
  name: string;
  fbxFileId?: string;
  previewFileId?: string;
  additional?: Array<{ fileId: string; name: string; variant: string }>;
}

interface Model3dResultEntry extends LaneResultEntry<ReusableModel3dReq> {
  previewFileId?: string;
}

/** The `Model3dGenRequest` behind a result, minus the source image — a
 *  base64 data URL has no business in localStorage, and the slot is re-picked
 *  by hand anyway. `hadMedia` records that the run consumed one. */
type ReusableModel3dReq = Omit<Model3dGenRequest, "image"> & { hadMedia?: boolean };

function stripReq(req: Model3dGenRequest): ReusableModel3dReq {
  const { image, ...rest } = req;
  return image ? { ...rest, hadMedia: true } : rest;
}

const JOB_KEY = "kawai-generator-model3d-job-v1";

/** History row → result entry (one mesh per run; the thumb-flagged file is
 *  the model3DPreview render that illustrates the card). */
function model3dEntriesFromJob(row: GenerationJobRow): Model3dResultEntry[] {
  let req: ReusableModel3dReq = {} as ReusableModel3dReq;
  try {
    req = JSON.parse(row.paramsJson || "{}") as ReusableModel3dReq;
  } catch {
    // A row with an unparseable snapshot still lists its mesh.
  }
  const primary = row.files.find((f) => !f.thumb);
  if (!primary) return [];
  const preview = row.files.find((f) => f.thumb);
  return [
    {
      fileId: primary.id,
      name: primary.name,
      jobId: row.id,
      previewFileId: preview?.id,
      prompt: (req.prompt ?? "").trim(),
      at: row.createdAt * 1000,
      req,
    },
  ];
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
        meta={resultMeta(entry.at, detailLine(entry.req?.modelVersion, entry.req?.mode))}
        onRemove={onRemove}
        onReuse={onReuse}
        token={mediaToken(entry.prompt, entry.fileId, entry.name)}
      />
    </div>
  );
}

/**
 * The 3D lane's empty state: curated prompt starters, shown per engine.
 *
 * There is no community 3D feed to read — Civitai's 3D models are ComfyUI
 * workflows whose ~21 posts yield four with meta, all of them the author's
 * own `type: "image"` texture renders, not mesh generations (measured
 * 2026-10-08). So the starters are the only thing this state can offer.
 *
 * Engines whose form has no prompt field (`promptMax: 0` — tripo, trellis2,
 * pixal3d, all image-to-3D only) get an honest note instead of cards that
 * could not do anything.
 */
function Model3dStarterList({ ecosystem, onApply }: { ecosystem: string; onApply: (starter: Model3dStarter) => void }) {
  const { t } = useI18n();
  if (MODEL3D_NO_PROMPT.includes(ecosystem)) {
    return <p className="text-muted-foreground text-xs">{t("model3dGenerator.startersNeedsImage")}</p>;
  }
  const starters = MODEL3D_STARTERS[ecosystem] ?? [];
  if (starters.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <span className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.startersTitle")}</span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {starters.map((starter) => (
          <button
            className="border-muted-foreground/70 hover:border-ring flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border bg-secondary/40 p-2.5 text-left transition-colors"
            key={starter.id}
            onClick={() => onApply(starter)}
            type="button"
          >
            <span className="text-[13px] font-semibold">{starter.label}</span>
            <span className="text-muted-foreground text-[11px] leading-snug">{starter.note}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export function Model3dGenerator() {
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

  const formReady = isTxt ? prompt.trim().length > 0 : image != null;

  const lane = useWorkflowLane<
    Model3dGenRequest,
    ReusableModel3dReq,
    Model3dStatusView,
    SavedModel3d,
    Model3dResultEntry
  >({
    configured,
    formEffective: formReady,
    lane: "model3d",
    keys: { job: JOB_KEY },
    fromJob: model3dEntriesFromJob,
    ops: {
      cost: "civitai_model3d_cost",
      status: "civitai_model3d_status",
      submit: "civitai_model3d_submit",
      fetch: "civitai_model3d_fetch",
    },
    labels: { done: "model3dGenerator.done", failed: "model3dGenerator.failedToast" },
    // 3D renders are slow — a meshy full run can take 10+ minutes, so give a
    // transport hiccup an hour of retries before declaring it stuck.
    stuckMs: 60 * 60 * 1000,
    buildRequest,
    strip: stripReq,
    promptLabel: () => prompt.trim(),
    succeeded: (st) => st.status === "succeeded" && st.model != null,
    fetchSaved: (st, workflowId) =>
      call<SavedModel3d>("civitai_model3d_fetch", {
        workflowId,
        modelUrl: st.model?.url,
        modelFormat: st.model?.format,
        fbxUrl: st.fbx?.url,
        fbxFormat: st.fbx?.format,
        previewUrl: st.previewUrl,
        extraUrls: st.extras ?? [],
      }),
  });
  const { cancel, cost, costError, elapsed, job, removeEntry, results, status, submit, submitting } = lane;
  const {
    groups: ecoGroups,
    open: ecoOpen,
    setOpen: setEcoOpen,
  } = useEcoGroups(MODEL3D_ECOSYSTEMS, ecoId, switchEcosystem);

  async function pickImage(file: File | undefined) {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      toast.error(t("model3dGenerator.sourceTooLarge"));
      return;
    }
    setImage(await readFileAsDataUrl(file));
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
                <ChoiceChip active={topology === top} className="flex-1" key={top} onClick={() => setTopology(top)}>
                  {t(`model3dGenerator.topology_${top}`)}
                </ChoiceChip>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.symmetry")}</Label>
            <div className="flex gap-1.5">
              {(["auto", "on", "off"] as const).map((s) => (
                <ChoiceChip active={symmetry === s} className="flex-1" key={s} onClick={() => setSymmetry(s)}>
                  {t(`model3dGenerator.symmetry_${s}`)}
                </ChoiceChip>
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
                <ChoiceChip
                  active={textureAlignment === a}
                  className="flex-1"
                  key={a}
                  onClick={() => setTextureAlignment(a)}
                >
                  {t(`model3dGenerator.align_${a}`)}
                </ChoiceChip>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.orientation")}</Label>
            <div className="flex gap-1.5">
              {(["default", "align_image"] as const).map((o) => (
                <ChoiceChip active={orientation === o} className="flex-1" key={o} onClick={() => setOrientation(o)}>
                  {t(`model3dGenerator.orient_${o}`)}
                </ChoiceChip>
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
      <EcoPicker
        ecoAriaLabel={t("model3dGenerator.ecosystem")}
        ecoGroups={ecoGroups}
        ecoLabel={eco.label}
        ecoOpen={ecoOpen}
        onEcoOpenChange={setEcoOpen}
      />
      <KeyStatusNotices configured={configured} />

      {/* Process — meshy only (every other engine is image-to-3D). */}
      {isMeshy && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("model3dGenerator.process")}</Label>
          <div className="flex gap-2">
            {eco.processes.map((p) => (
              <ChoiceChip
                active={process === p}
                className="flex-1"
                key={p}
                onClick={() => {
                  setProcess(p);
                  setImage(null);
                }}
              >
                {t(p === "textTo3D" ? "model3dGenerator.txt2_3d" : "model3dGenerator.img2_3d")}
              </ChoiceChip>
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
              <ChoiceChip
                active={modelVersion === m.key}
                className="px-3"
                key={m.key}
                onClick={() => setModelVersion(m.key)}
              >
                {m.label}
              </ChoiceChip>
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
              <ChoiceChip active={mode === m} className="flex-1" key={m} onClick={() => setMode(m)}>
                {t(`model3dGenerator.mode_${m}`)}
              </ChoiceChip>
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
              <ChoiceChip active={tripoTexture === tx} className="flex-1" key={tx} onClick={() => setTripoTexture(tx)}>
                {t(`model3dGenerator.texture_${tx}`)}
              </ChoiceChip>
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

  /** Load a curated starter. A Hunyuan3D starter carries a texture hint
   *  rather than a subject prompt, so it fills the texture field instead. */
  function applyModel3dStarter(starter: Model3dStarter) {
    if (starter.texturePrompt) {
      setTexturePrompt(starter.texturePrompt);
    } else {
      setPrompt(starter.prompt);
    }
    toast.success(t("model3dGenerator.starterApplied"));
  }

  return (
    <GeneratorLayout
      footer={
        <GenerateFooter
          canSubmit={lane.canSubmit}
          inFlight={job != null}
          inFlightLabel={t("model3dGenerator.inProgress")}
          note={t("model3dGenerator.costNote")}
          onSubmit={() => void submit()}
          quote={cost?.totalTokens ?? null}
          quoteState={costError ? "failed" : cost ? "quoted" : formReady && configured === true ? "pending" : "idle"}
          ready={cost?.ready ?? true}
          submitting={submitting}
          submittingLabel={t("generator.generatingElapsed", { seconds: elapsed })}
          submitLabel={t("generator.generate")}
          warnings={cost?.warnings ?? []}
        />
      }
      form={form}
      header={
        <ResultsPaneHeader
          meta={t("generator.resultsCount", { count: results.length })}
          title={t("generator.results")}
        />
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-auto p-3 pb-24 lg:overscroll-contain lg:pb-3">
        {job && (
          <div className="mb-3">
            <JobCard
              cancelLabel={t("model3dGenerator.cancel")}
              elapsed={elapsed}
              error={status?.error}
              onCancel={cancel}
              queuePosition={status?.queuePosition}
              statusLabel={t(laneStatusKey("model3dGenerator", status))}
              workflowId={job.workflowId}
            />
          </div>
        )}
        {results.length === 0 && !job ? (
          <Model3dStarterList ecosystem={ecoId} onApply={applyModel3dStarter} />
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
    </GeneratorLayout>
  );
}
