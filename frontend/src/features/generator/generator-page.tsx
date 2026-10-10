import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { refreshTokenBalance } from "@/features/topup/use-token-balance";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/shared/icon";
import type { MediaMode } from "@/app/modes";
import { cn } from "@/lib/utils";
import { call, errText, type ModelCover, type SavedImage, type TemplatePreset } from "@/lib/api";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { useFilePreview } from "@/lib/preview-file";
import { useI18n } from "@/hooks/use-i18n";
import {
  type GenParams,
  type SearchModelPage,
  type SearchModelRow,
  DEFAULT_WORKFLOW,
  ECOSYSTEMS,
  WORKFLOWS,
  TOKENS_PER_BUZZ,
  ecosystemsForWorkflow,
  estimateBuzz,
  isSdFamily,
  isWorkflowAvailable,
  resolveCompatibleEcosystem,
  targetWorkflowForEcosystem,
} from "./ecosystems";
import { AdvancedSection } from "./advanced-section";
import {
  fetchGenerationHistory,
  type GenerationJob,
  KeyStatusNotices,
  useAliveEffect,
  useCivitaiKeyStatus,
} from "./civitai-shared";
import { GenerateFooter, publishMediaDebit } from "./generate-footer";
import { MusicGenerator } from "./music-generator";
import { Model3dGenerator } from "./model3d-generator";
import { Masonry, useColumnCount } from "./masonry";
import { type PickerGroup, type PickerItem, PickerMenu } from "./picker-menu";
import { ResultActions, mediaToken } from "./result-actions";
import {
  ChoiceChip,
  EcoPicker,
  EmptyResults,
  GeneratorLayout,
  NumberStepper,
  ResultsPaneHeader,
  resultMeta,
  segmentClass,
  SEGMENTED_LIST,
} from "./generator-shell";
import { VideoGenerator } from "./video-generator";

/** The `GenParams` that produced a result, minus the prompt (the entry carries
 *  it already) and the uploaded source image — a base64 data URL has no
 *  business in localStorage, and the form re-asks for it anyway.
 *  `hadSourceImage` records that the run consumed one. */
interface ReusableParams extends Omit<GenParams, "sourceImage" | "prompt"> {
  /** Checkpoint display name — `GenParams` only carries its AIR URN. */
  modelName?: string;
  /** The run consumed a source image (never persisted). */
  hadSourceImage?: boolean;
}

interface HistoryEntry {
  fileId: string;
  name: string;
  /** The history row (generation_jobs) this image belongs to — removing one
   *  card of a multi-image run removes the whole run. */
  jobId: string;
  prompt: string;
  at: number;
  /** Generating settings, for the card's "Load these settings" action.
   *  Absent on entries logged before snapshots existed — those restore the
   *  prompt only. */
  params?: ReusableParams;
}

interface LoraEntry {
  id: string;
  air: string;
  strength: string;
  /** Present when added via the browser (paste rows carry none). */
  name?: string;
}

interface SelectedModel {
  name: string;
  airUrn: string;
  coverUrl: string | null;
}

const MAX_HISTORY = 50;

/** History row → result entries (one row per run; quantity>1 yields several
 *  cards sharing the row id). `paramsJson` is the submitted `GenParams` minus
 *  the uploaded source image — the form re-asks for it anyway. */
function imageEntriesFromJob(row: GenerationJob): HistoryEntry[] {
  let parsed: Partial<GenParams> = {};
  try {
    parsed = JSON.parse(row.paramsJson || "{}") as Partial<GenParams>;
  } catch {
    // A row with an unparseable snapshot still lists its images.
  }
  const { prompt: _prompt, sourceImage: _sourceImage, ...rest } = parsed;
  return row.files.map((f) => ({
    fileId: f.id,
    name: f.name,
    jobId: row.id,
    prompt: typeof parsed.prompt === "string" ? parsed.prompt : "",
    at: row.createdAt * 1000,
    params: rest as ReusableParams,
  }));
}

/** Civitai's additional-resources slot cap mirrored in the panel header. */
const MAX_LORAS = 9;

/**
 * Sent when the user leaves the negative-prompt field empty — a first-time user
 * should not have to know the term to get clean output. Anything the user types
 * replaces it wholesale (never merged), so the field stays the single source of
 * truth for the request. Image lane only: the video lane's negative prompt
 * rides a different ecosystem capability set and stays fully user-driven.
 */
const DEFAULT_NEGATIVE_PROMPT = "blurry, low quality, text, watermark, extra fingers";

function compactCount(n: number | null): string {
  if (n === null) return "";
  return new Intl.NumberFormat("en", { notation: "compact" }).format(n);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Aspect-ratio chip with a proportionally drawn rectangle — the civitai
 *  aspect picker's visual language. */
function AspectChip({
  active,
  height,
  label,
  onClick,
  sub,
  width,
}: {
  active: boolean;
  height: number;
  label: string;
  onClick: () => void;
  /** Resolution line under the ratio (civitai's chip layout). */
  sub: string;
  width: number;
}) {
  const scale = 22 / Math.max(width, height);
  return (
    <button
      aria-pressed={active}
      className={cn(
        "flex min-w-0 flex-1 flex-col items-center gap-1.5 rounded-[8px] border bg-secondary p-2 transition-colors",
        active ? "border-primary text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
      onClick={onClick}
      type="button"
    >
      <div className="flex h-6 items-center justify-center">
        <div
          className={cn("rounded-[3px]", active ? "bg-primary" : "bg-muted-foreground")}
          style={{
            height: Math.max(6, height * scale),
            width: Math.max(6, width * scale),
          }}
        />
      </div>
      <span className="text-[10px] leading-none font-medium">{label}</span>
      <span className="text-muted-foreground/70 text-[10px] leading-none">{sub}</span>
    </button>
  );
}

function ModelTile({ cover, eco, size }: { cover?: string | null; eco: (typeof ECOSYSTEMS)[number]; size: number }) {
  if (cover) {
    return <img alt="" className="shrink-0 rounded-[6px] object-cover" height={size} src={cover} width={size} />;
  }
  return (
    <div
      className={cn(
        "flex shrink-0 items-center justify-center rounded-[6px] bg-gradient-to-br text-sm font-bold text-white",
        eco.gradient,
      )}
      style={{ height: size, width: size }}
    >
      {eco.label.charAt(0)}
    </div>
  );
}

/** One saved result: full-frame thumbnail, hover actions, click opens preview.
 *
 * The tile keeps the image's own aspect — four of the five size presets are
 * non-square, so a square crop threw most generations away. The reserved box
 * comes from the run's own dimensions when the snapshot has them (no layout
 * shift as the tile loads); legacy entries fall back to a square. */
function ResultCard({ entry, onRemove, onReuse }: { entry: HistoryEntry; onRemove: () => void; onReuse: () => void }) {
  // The tile renders the 512px preview JPEG, never the original — a 4K PNG
  // would be megabytes of base64 per card. Click-to-preview reads the full
  // file through the overlay.
  const { data, isLoading } = useFilePreview({ id: entry.fileId, name: entry.name, thumb: true });
  const dims = entry.params;
  return (
    <div
      className={cn(
        "group relative overflow-hidden rounded-[8px] border bg-secondary",
        // No snapshot (a pre-existing entry) — the children are h-full, so the
        // box still needs a height. Square is the old behaviour.
        !dims && "aspect-square",
      )}
      style={dims ? { aspectRatio: `${dims.width} / ${dims.height}` } : undefined}
    >
      <button
        className="block h-full w-full cursor-zoom-in"
        onClick={() => emitOpenPreview(entry.fileId, entry.name)}
        title={entry.prompt}
        type="button"
      >
        {isLoading ? (
          <div className="flex h-full w-full items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <img
            alt={entry.prompt}
            className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            src={data?.dataUrl}
          />
        )}
      </button>
      <ResultActions
        fileId={entry.fileId}
        fileName={entry.name}
        label={entry.prompt || entry.name}
        meta={resultMeta(entry.at, dims ? `${dims.width}×${dims.height}` : undefined)}
        onRemove={onRemove}
        onReuse={onReuse}
        token={mediaToken(entry.prompt, entry.fileId, entry.name)}
      />
    </div>
  );
}

/** Rich resource card for the model browser — civitai's model-card look:
 *  image CAROUSEL (cover + showcase examples), name, creator, stats, base
 *  model, description snippet. */
function BrowserCard({
  eco,
  onSelect,
  row,
  selected,
}: {
  eco: (typeof ECOSYSTEMS)[number];
  onSelect: (row: SearchModelRow) => void;
  row: SearchModelRow;
  selected: boolean;
}) {
  const gallery = useMemo(() => [row.coverUrl, ...row.exampleUrls].filter((u): u is string => Boolean(u)), [row]);
  const [idx, setIdx] = useState(0);
  const at = Math.min(idx, gallery.length - 1);

  return (
    <div
      className={cn(
        "group overflow-hidden rounded-[10px] border bg-secondary text-left transition-colors hover:brightness-110",
        selected && "border-primary ring-1 ring-primary",
      )}
    >
      <div className="relative w-full overflow-hidden bg-background">
        <button className="block w-full cursor-pointer" onClick={() => onSelect(row)} type="button">
          {gallery[at] ? (
            <img alt={row.name} className="block h-auto w-full" loading="lazy" src={gallery[at]} />
          ) : (
            <div className="flex min-h-40 w-full items-center justify-center">
              <ModelTile eco={eco} size={72} />
            </div>
          )}
        </button>
        {/* Carousel controls — cover + example images cycle in place */}
        {gallery.length > 1 && (
          <>
            <Button
              aria-label="Previous image"
              className="absolute top-1/2 left-1.5 z-10 size-6 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70"
              onClick={() => setIdx((at - 1 + gallery.length) % gallery.length)}
              size="icon"
              variant="ghost"
            >
              <Icon className="size-3.5" name="chevron-left" />
            </Button>
            <Button
              aria-label="Next image"
              className="absolute top-1/2 right-1.5 z-10 size-6 -translate-y-1/2 rounded-full bg-black/50 text-white hover:bg-black/70"
              onClick={() => setIdx((at + 1) % gallery.length)}
              size="icon"
              variant="ghost"
            >
              <Icon className="size-3.5" name="chevron-right" />
            </Button>
            <div className="pointer-events-none absolute inset-x-0 bottom-1.5 z-10 flex justify-center gap-1">
              {gallery.map((url, i) => (
                <span className={cn("size-1.5 rounded-full", i === at ? "bg-primary" : "bg-foreground/40")} key={url} />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex flex-col gap-1 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <span className="text-foreground line-clamp-1 text-[13px] font-semibold">{row.name}</span>
          {selected && <Icon className="mt-0.5 size-3.5 shrink-0" name="check" />}
        </div>
        <span className="text-muted-foreground text-[11px]">
          {row.creator ?? "—"}
          {row.downloads !== null && <span> · {compactCount(row.downloads)} ⬇</span>}
          {row.thumbsUp !== null && <span className="text-warning"> · {compactCount(row.thumbsUp)} ❤</span>}
        </span>
        {row.description && (
          <span className="text-muted-foreground/70 line-clamp-2 text-[11px] leading-snug">{row.description}</span>
        )}
        {row.baseModel && (
          <span className="text-muted-foreground/70 w-fit rounded border px-1 py-px text-[10px]">{row.baseModel}</span>
        )}
      </div>
    </div>
  );
}

/**
 * The model browser, rendered as a modal over the results pane. It used to
 * REPLACE the results pane (a Hasil|Model tab switch), so picking a model or
 * a LoRA made the user's generated media vanish. As a dialog the results stay
 * mounted and visible behind it, and the browser keeps the room it needs for
 * full model cards. Checkpoint click selects the diffuser override, LoRA
 * click adds to the stack.
 */
function ModelBrowser({
  eco,
  onAddLora,
  onSelectModel,
  selectedModel,
  title,
  type,
  onTypeChange,
  addedLoraAirs,
  loraCount,
}: {
  eco: (typeof ECOSYSTEMS)[number];
  onAddLora: (row: SearchModelRow) => void;
  onSelectModel: (model: SelectedModel | null) => void;
  selectedModel: SelectedModel | null;
  /** Dialog heading — names what the current `type` tab is browsing. */
  title: string;
  type: "Checkpoint" | "LORA";
  onTypeChange: (type: "Checkpoint" | "LORA") => void;
  /** AIR URNs already in the LoRA stack — re-clicking one is a no-op. */
  addedLoraAirs: Set<string>;
  loraCount: number;
}) {
  const { t } = useI18n();
  const cols = useColumnCount(3);
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sort, setSort] = useState("Highest Rated");
  const [rows, setRows] = useState<SearchModelRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query.trim()), 500);
    return () => clearTimeout(timer);
  }, [query]);

  // The in-flight request's cancel flag, so a Retry supersedes the attempt
  // that produced the error and the effect's cleanup cancels it.
  const inFlight = useRef({ cancelled: false });

  // Page 1 (replace) — every filter change restarts the feed. Retry re-invokes
  // this directly, so the error state is never a dead end.
  const fetchFirstPage = useCallback(async () => {
    inFlight.current.cancelled = true;
    const signal = { cancelled: false };
    inFlight.current = signal;
    setLoading(true);
    setError(null);
    setRows([]);
    setNextCursor(null);
    try {
      const page = await call<SearchModelPage>("civitai_search_models", {
        ecosystem: eco.id,
        query: debouncedQuery || undefined,
        modelType: type,
        sort,
        limit: 24,
      });
      if (signal.cancelled) return;
      setRows(page.rows);
      setNextCursor(page.nextCursor);
    } catch (e) {
      if (signal.cancelled) return;
      setRows([]);
      setError(errText(e));
    } finally {
      if (!signal.cancelled) setLoading(false);
    }
  }, [debouncedQuery, eco.id, sort, type]);

  useEffect(() => {
    void fetchFirstPage();
    return () => {
      inFlight.current.cancelled = true;
    };
  }, [fetchFirstPage]);

  const loadMore = useCallback(() => {
    if (loadingMore || nextCursor === null) return;
    setLoadingMore(true);
    call<SearchModelPage>("civitai_search_models", {
      ecosystem: eco.id,
      query: debouncedQuery || undefined,
      modelType: type,
      sort,
      limit: 24,
      cursor: nextCursor,
    })
      .then((page) => {
        setRows((prev) => {
          const seen = new Set(prev.map((r) => r.modelId));
          return [...prev, ...page.rows.filter((r) => !seen.has(r.modelId))];
        });
        setNextCursor(page.nextCursor);
      })
      .catch((e) => toast.error(errText(e)))
      .finally(() => setLoadingMore(false));
  }, [eco.id, type, debouncedQuery, sort, nextCursor, loadingMore]);

  // Infinite scroll — fetch the next page shortly before the bottom.
  function handleScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 480) loadMore();
  }

  function handleSelect(row: SearchModelRow) {
    if (type === "LORA") {
      if (addedLoraAirs.has(row.airUrn)) {
        toast.info(t("generator.loraAlreadyAdded", { name: row.name }));
        return;
      }
      if (loraCount >= MAX_LORAS) {
        toast.error(t("generator.loraLimitReached"));
        return;
      }
      onAddLora(row);
      toast.success(t("generator.loraAdded", { name: row.name }));
      return;
    }
    onSelectModel({
      name: row.name,
      airUrn: row.airUrn,
      coverUrl: row.coverUrl,
    });
  }

  const sortOptions = [
    { value: "Highest Rated", label: t("generator.sortHighest") },
    { value: "Most Downloaded", label: t("generator.sortDownloads") },
    { value: "Newest", label: t("generator.sortNewest") },
  ];

  return (
    <DialogContent
      className="flex h-[min(80vh,44rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-4xl"
      onOpenAutoFocus={(e) => e.preventDefault()}
    >
      <DialogHeader className="shrink-0 space-y-0 border-b px-4 py-3">
        <DialogTitle className="text-sm">{title}</DialogTitle>
        <DialogDescription className="text-xs">
          {type === "LORA"
            ? t("generator.browserLoraHint", { count: loraCount, max: MAX_LORAS })
            : selectedModel
              ? t("generator.browserSelected", { name: selectedModel.name })
              : t("generator.browserDefault")}
        </DialogDescription>
      </DialogHeader>
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Filters: search + type tabs + sort */}
        <div className="flex flex-wrap items-center gap-2 border-b p-3">
          <div className="relative min-w-[180px] flex-1">
            <Icon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2" name="search" />
            <Input
              className="h-8 rounded-[8px] pr-3 pl-8 text-sm"
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("generator.searchPlaceholder")}
              value={query}
            />
          </div>
          <div className={SEGMENTED_LIST}>
            {(["Checkpoint", "LORA"] as const).map((tt) => (
              <button
                aria-pressed={type === tt}
                className={segmentClass(type === tt)}
                key={tt}
                onClick={() => onTypeChange(tt)}
                type="button"
              >
                {tt === "Checkpoint" ? t("generator.typeCheckpoint") : t("generator.typeLora")}
              </button>
            ))}
          </div>
          <Select onValueChange={setSort} value={sort}>
            <SelectTrigger className="h-8 w-[170px] rounded-[8px] text-xs">
              {sortOptions.find((o) => o.value === sort)?.label}
            </SelectTrigger>
            <SelectContent className="z-[60] rounded-[8px]" position="popper">
              {sortOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Grid */}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3" onScroll={handleScroll}>
          {loading ? (
            // Skeleton rows, not one centered spinner: the grid's shape is the
            // whole point of this browser, so reserve it while the page loads.
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }, (_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder set, never reordered
                <div className="overflow-hidden rounded-[10px] border" key={i}>
                  <Skeleton className="aspect-[4/3] w-full rounded-none" />
                  <div className="flex flex-col gap-1.5 p-2.5">
                    <Skeleton className="h-3 w-3/4" />
                    <Skeleton className="h-2.5 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : error ? (
            <div className="border-muted-foreground/70 mx-auto flex h-40 max-w-md flex-col items-center justify-center gap-2 rounded-[8px] border p-4 text-center">
              <Icon className="size-8 stroke-1" name="alert-triangle" />
              <p className="text-xs break-words">{error}</p>
              <Button
                className="mt-1 h-7 rounded-[6px] px-2 text-xs"
                onClick={() => void fetchFirstPage()}
                size="sm"
                variant="secondary"
              >
                {t("generator.retry")}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="text-muted-foreground flex h-40 flex-col items-center justify-center gap-2">
              <Icon className="size-12 stroke-1" name="inbox" />
              <p className="text-sm">{t("generator.noResults")}</p>
            </div>
          ) : (
            <Masonry
              cols={cols}
              items={rows}
              keyOf={(row) => String(row.modelId)}
              render={(row) => (
                <BrowserCard
                  eco={eco}
                  onSelect={handleSelect}
                  row={row}
                  selected={
                    type === "Checkpoint" ? selectedModel?.airUrn === row.airUrn : addedLoraAirs.has(row.airUrn)
                  }
                />
              )}
            />
          )}
          {loadingMore && (
            <div className="flex justify-center py-3">
              <Spinner className="size-5" />
            </div>
          )}
        </div>
      </div>
    </DialogContent>
  );
}

/**
 * Image lane — Civitai image generation laid out like the civitai generation
 * panel (control treatment, cover-art model picker, Buzz footer), themed
 * through kawai's global token layer so it follows the app's light/dark
 * theme. The model BROWSER opens as a modal over the results pane, so it has
 * room for full model info without hiding the user's generated media.
 * Direct-op path (no supervisor); the op is synchronous and spends Buzz —
 * the Generate click is the consent. Results land in the office store and
 * embed anywhere `kawai-file://` tokens render. The API key is vault-baked.
 */
function ImageGenerator() {
  const { t } = useI18n();
  const configured = useCivitaiKeyStatus();
  /** The model browser overlays the results pane as a modal, so it no longer
   *  needs a pane tab — picking a model leaves the user's media in place. */
  const [browserOpen, setBrowserOpen] = useState(false);
  const [covers, setCovers] = useState<Record<string, ModelCover>>({});
  const [pickerType, setPickerType] = useState<"Checkpoint" | "LORA">("Checkpoint");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState<SelectedModel | null>(null);

  const [ecoId, setEcoId] = useState(ECOSYSTEMS[0].id);
  const eco = ECOSYSTEMS.find((e) => e.id === ecoId) ?? ECOSYSTEMS[0];
  const [workflowId, setWorkflowId] = useState(DEFAULT_WORKFLOW);
  const [wfOpen, setWfOpen] = useState(false);
  const [ecoOpen, setEcoOpen] = useState(false);
  const workflow = WORKFLOWS.find((w) => w.id === workflowId) ?? WORKFLOWS[0];
  /** Data URL of the uploaded source image (image-input workflows). */
  const [sourceImage, setSourceImage] = useState<string | null>(null);
  /** Natural dimensions of the loaded source image — img2img derives its
   *  output size from them (civitai's aspectRatio-depends-on-images rule),
   *  rounded to %16 and clamped to the recipe bounds. */
  const [sourceDims, setSourceDims] = useState<{ width: number; height: number } | null>(null);
  /** createVariant denoise strength, 0–1. */
  const [strength, setStrength] = useState("0.7");
  /** Upscale passes for the upscale-backed workflows (1–3). */
  const [upscaleRepeats, setUpscaleRepeats] = useState(1);
  /** Hires-fix input mode — civitai renders one hires workflow with a
   *  Text-to-Image / Image-to-Image segmented control on top. */
  const [hiresMode, setHiresMode] = useState<"text" | "image">("text");
  const [sizeIdx, setSizeIdx] = useState(0);
  /** A template's own dimensions, overriding the aspect chips. The chips
   *  are ~1 MP buckets; a community image's real size (often portrait or a
   *  4:5 crop) is not on the list, and snapping to the nearest chip both
   *  changed the composition and dropped the resolution. Cleared by any
   *  chip click, ecosystem switch, or history reuse. */
  const [templateSize, setTemplateSize] = useState<{ width: number; height: number } | null>(null);
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [seed, setSeed] = useState("");
  const [cfgScale, setCfgScale] = useState(String(ECOSYSTEMS[0].defaultCfgScale));
  const [steps, setSteps] = useState(String(ECOSYSTEMS[0].defaultSteps));
  /** sdcpp sampler display name — SD-family only (the wire
   *  carries sampleMethod/schedule only for Sd1/Sdxl);
   *  "Euler" is the orchestrator's own default. */
  const [sampler, setSampler] = useState("Euler");
  /** CLIP layers to skip — SD-family only, 1–3 (spec default 2). */
  const [clipSkip, setClipSkip] = useState("2");
  const [loras, setLoras] = useState<LoraEntry[]>([]);

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<HistoryEntry[]>([]);
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const aliveRef = useRef(true);
  useAliveEffect(aliveRef);

  /** History lives in the backend `generation_jobs` table (per-user SQLite) —
   *  reload from the `generation_history` op on mount and after each run. */
  const refreshResults = useCallback(() => {
    fetchGenerationHistory("image", MAX_HISTORY)
      .then((rows) => {
        if (aliveRef.current) setResults(rows.flatMap(imageEntriesFromJob));
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshResults();
  }, [refreshResults]);

  // Cover art (v1 reads) — alive-gated so an unmount mid-fetch is safe.
  useEffect(() => {
    call<ModelCover[]>("civitai_model_covers")
      .then((list) => {
        const map: Record<string, ModelCover> = {};
        for (const c of list) map[c.ecosystem] = c;
        if (aliveRef.current) setCovers(map);
      })
      .catch(() => undefined);
  }, []);

  const size = templateSize ?? eco.sizes[sizeIdx] ?? eco.sizes[0];
  // Per-workflow form shape (civitai's per-workflow graphs): the upscale
  // workflow renders generation-free (image + passes only — no prompt,
  // ecosystem, model, LoRA, sampling); img2img renders image-first and
  // derives its output size from the source image.
  const isUpscale = workflowId === "img2img:upscale";
  const isImg2Img = workflowId === "img2img";
  /** Hires-fix running in its Image-to-Image mode (source image required,
   *  denoise slider shown — the generate leg is createVariant). */
  const hiresImg = workflowId === "txt2img:hires-fix" && hiresMode === "image";
  const needsSource = workflow.input === "image" || hiresImg;
  /** The negative prompt is folded away until asked for; `reuseEntry` opens it
   *  when the restored run actually carried a value, so a reused negative
   *  prompt is never silently hidden. */
  const [negativeOpen, setNegativeOpen] = useState(false);
  const genSize =
    (isImg2Img || hiresImg) && sourceDims
      ? {
          width: Math.min(2048, Math.max(64, Math.round(sourceDims.width / 16) * 16)),
          height: Math.min(2048, Math.max(64, Math.round(sourceDims.height / 16) * 16)),
        }
      : size;
  const parsedSteps = Number(steps);
  // Buzz pricing is a per-pixel/per-step generation formula plus the upscale
  // passes the imageUpscaler recipe bills separately — `estimateBuzz` mirrors
  // the backend's estimate exactly so the quote can't under-report.
  const estimate = useMemo(
    () =>
      estimateBuzz({
        width: genSize.width,
        height: genSize.height,
        steps: Number.isFinite(parsedSteps) ? parsedSteps : undefined,
        quantity,
        workflow: workflowId,
        upscaleRepeats,
      }),
    [genSize, parsedSteps, quantity, workflowId, upscaleRepeats],
  );
  const quotedTokens = Math.ceil(estimate * TOKENS_PER_BUZZ);

  const buildParams = useCallback((): GenParams => {
    // The upscale workflow carries no generation fields at all (its recipe
    // takes only image + repeats) — send a minimal body.
    if (isUpscale) {
      return {
        ecosystem: eco.id,
        engine: eco.engine,
        workflow: workflowId,
        prompt: "",
        sourceImage: sourceImage ?? undefined,
        upscaleRepeats,
        width: genSize.width,
        height: genSize.height,
      };
    }
    const cleanedLoras = loras
      .map((l) => ({ air: l.air.trim(), strength: Number(l.strength) || 1 }))
      .filter((l) => l.air.length > 0);
    // Empty/invalid CLIP-skip input falls back to the spec
    // default (None = 2) instead of failing the generate call.
    const parsedClipSkip = Number(clipSkip);
    const clipSkipValue = parsedClipSkip >= 1 && parsedClipSkip <= 3 ? parsedClipSkip : undefined;
    return {
      ecosystem: eco.id,
      engine: eco.engine,
      workflow: workflowId,
      prompt: prompt.trim(),
      sourceImage: needsSource ? (sourceImage ?? undefined) : undefined,
      strength: isImg2Img || hiresImg ? Number(strength) : undefined,
      upscaleRepeats: workflowId === "txt2img:hires-fix" ? upscaleRepeats : undefined,
      width: genSize.width,
      height: genSize.height,
      quantity,
      negativePrompt: negativePrompt.trim() || DEFAULT_NEGATIVE_PROMPT,
      cfgScale: Number(cfgScale),
      steps: Number(steps),
      seed: seed.trim() ? Number(seed) : undefined,
      sampler: isSdFamily(eco.id) ? sampler : undefined,
      clipSkip: isSdFamily(eco.id) ? clipSkipValue : undefined,
      loras: cleanedLoras.length > 0 ? cleanedLoras : undefined,
      diffuserModel: selectedModel?.airUrn,
    };
  }, [
    eco,
    hiresImg,
    isImg2Img,
    isUpscale,
    needsSource,
    workflowId,
    genSize,
    prompt,
    negativePrompt,
    quantity,
    cfgScale,
    steps,
    seed,
    sampler,
    clipSkip,
    loras,
    selectedModel,
    sourceImage,
    strength,
    upscaleRepeats,
  ]);

  // Elapsed ticker while a run is in flight.
  useEffect(() => {
    if (!running) return;
    const startedAt = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // Ecosystem switch invalidates the custom checkpoint (AIR URNs are
  // ecosystem-scoped). Coherence (civitai's selectorCoherence): a write that
  // would leave workflow/ecosystem incompatible retargets the other selector
  // in the same gesture — the ecosystem gesture wins.
  const switchEcosystem = useCallback(
    (id: string) => {
      if (!isWorkflowAvailable(workflowId, id)) {
        setWorkflowId(targetWorkflowForEcosystem(id));
      }
      setEcoId(id);
      setSizeIdx(0);
      setTemplateSize(null);
      setSelectedModel(null);
      const next = ECOSYSTEMS.find((e) => e.id === id);
      if (next) {
        setCfgScale(String(next.defaultCfgScale));
        setSteps(String(next.defaultSteps));
      }
    },
    [workflowId],
  );

  const switchWorkflow = useCallback(
    (id: string) => {
      setWorkflowId(id);
      const compatible = resolveCompatibleEcosystem(id, ecoId);
      if (compatible !== ecoId) {
        switchEcosystem(compatible);
      }
    },
    [ecoId, switchEcosystem],
  );

  async function handleGenerate() {
    if (running) return;
    const params = buildParams();
    if (needsSource && !params.sourceImage) {
      toast.error(t("generator.sourceImageRequired"));
      return;
    }
    if (workflowId !== "img2img:upscale" && params.prompt.length === 0) {
      toast.error(t("generator.promptRequired"));
      return;
    }
    setRunning(true);
    try {
      // Client pre-check (display-grade): the docs-formula estimate converted
      // to app tokens vs the shared balance. An unreadable balance falls
      // through — the server-side debit inside the op is the authoritative
      // fail-closed gate.
      const required = quotedTokens;
      const balance = await refreshTokenBalance();
      if (balance !== null && balance < required) {
        toast.error(t("generator.insufficientBalance", { tokens: required.toLocaleString("id-ID") }));
        setRunning(false);
        return;
      }
      const saved = await call<SavedImage[]>("civitai_generate", { params });
      publishMediaDebit(quotedTokens);
      // The op recorded the run in `generation_jobs` — reload instead of
      // maintaining a client-side log.
      refreshResults();
      toast.success(t("generator.done", { count: saved.length }));
    } catch (e) {
      toast.error(`${t("generator.failed")}: ${errText(e)}`);
    } finally {
      if (aliveRef.current) setRunning(false);
    }
  }

  /** Load a result's generating settings back into the form — the iteration
   *  loop (generate → tweak → generate) without re-picking every control.
   *  The source image is never persisted, so image-input workflows need it
   *  re-asked; the form's own gate says so. */
  function reuseEntry(entry: HistoryEntry) {
    const p = entry.params;
    if (!p) {
      setPrompt(entry.prompt);
      toast.success(t("generator.settingsReusedPromptOnly"));
      return;
    }
    const nextEco = ECOSYSTEMS.find((e) => e.id === p.ecosystem) ?? ECOSYSTEMS[0];
    setWorkflowId(WORKFLOWS.find((w) => w.id === p.workflow)?.id ?? DEFAULT_WORKFLOW);
    setEcoId(nextEco.id);
    setPrompt(entry.prompt);
    setNegativePrompt(p.negativePrompt ?? "");
    // The negative prompt is folded away by default — reveal it when the
    // restored run actually carried one, so reuse never hides a setting.
    setNegativeOpen((p.negativePrompt ?? "").trim().length > 0);
    setQuantity(Math.max(1, Math.min(12, p.quantity ?? 1)));
    setCfgScale(String(p.cfgScale ?? nextEco.defaultCfgScale));
    setSteps(String(p.steps ?? nextEco.defaultSteps));
    setSeed(p.seed != null ? String(p.seed) : "");
    setSampler(p.sampler ?? "Euler");
    setClipSkip(p.clipSkip != null ? String(p.clipSkip) : "2");
    if (p.strength != null) setStrength(String(p.strength));
    setUpscaleRepeats(p.upscaleRepeats ?? 1);
    setLoras((p.loras ?? []).map((l) => ({ id: crypto.randomUUID(), air: l.air, strength: String(l.strength) })));
    setSelectedModel(
      p.diffuserModel ? { name: p.modelName ?? p.diffuserModel, airUrn: p.diffuserModel, coverUrl: null } : null,
    );
    // The size chip is the same list the form renders — match on the exact
    // dimensions so the restored pick keeps its label.
    const sizeIdx = nextEco.sizes.findIndex((s) => s.width === p.width && s.height === p.height);
    setSizeIdx(sizeIdx >= 0 ? sizeIdx : 0);
    setTemplateSize(null);
    setHiresMode("text");
    setSourceImage(null);
    setSourceDims(null);
    toast.success(t("generator.settingsReused"));
    if (p.hadSourceImage) toast.info(t("generator.sourceNotRestored"));
  }

  /** Load a community template into the form. Templates are txt2img — the
   *  workflow switches back if the user was on an image-input one. The
   *  seed stays random; the template's own checkpoint + LoRA stack ride
   *  along (resolved server-side from `meta.civitaiResources`), so the
   *  generation is the source model's, not the builtin diffuser's. The
   *  gallery is NOT filtered by the selected ecosystem, so a preset from
   *  another family first switches the panel to ITS ecosystem — its
   *  checkpoint + LoRAs are family-gated there, and cfg/steps follow the
   *  new ecosystem's defaults when the preset carries none. */
  function applyTemplate(p: TemplatePreset) {
    const nextEco = ECOSYSTEMS.find((e) => e.id === p.ecosystem) ?? eco;
    const switching = nextEco.id !== eco.id;
    setWorkflowId(DEFAULT_WORKFLOW);
    if (switching) setEcoId(nextEco.id);
    setPrompt(p.prompt);
    const negative = (p.negativePrompt ?? "").trim();
    setNegativePrompt(negative);
    // The negative prompt is folded away by default — reveal it when the
    // template actually carries one, same contract as reuseEntry.
    setNegativeOpen(negative.length > 0);
    if (p.cfgScale != null) setCfgScale(String(p.cfgScale));
    else if (switching) setCfgScale(String(nextEco.defaultCfgScale));
    if (p.steps != null) setSteps(String(p.steps));
    else if (switching) setSteps(String(nextEco.defaultSteps));
    if (isSdFamily(nextEco.id) && p.sampler) setSampler(p.sampler);
    // The image's real dimensions, not the nearest aspect chip: the chips
    // are ~1 MP buckets, so snapping both changed the composition and threw
    // away resolution (an 832×1216 SDXL portrait became 416×624). Clamped to
    // the recipe's rules (%16, 64–2048) exactly like the img2img source path.
    const dims = {
      width: Math.min(2048, Math.max(64, Math.round(p.width / 16) * 16)),
      height: Math.min(2048, Math.max(64, Math.round(p.height / 16) * 16)),
    };
    const exact = nextEco.sizes.findIndex((s) => s.width === dims.width && s.height === dims.height);
    if (exact >= 0) {
      setSizeIdx(exact);
      setTemplateSize(null);
    } else {
      setTemplateSize(dims);
    }
    // The template's own stack rides along: checkpoint as the diffuser
    // override + its LoRAs (family-gated server-side, so everything here is
    // generatable in this ecosystem). Replace, not merge — same contract as
    // reuseEntry, the form then reflects the template exactly.
    setSelectedModel(p.checkpoint ? { name: p.checkpoint.name, airUrn: p.checkpoint.airUrn, coverUrl: null } : null);
    setLoras(
      p.loras.slice(0, MAX_LORAS).map((l) => ({
        id: crypto.randomUUID(),
        air: l.airUrn,
        strength: String(l.strength ?? 1),
        name: l.name,
      })),
    );
    toast.success(t("generator.templateApplied"));
  }

  /** Drop a run from the panel's history — the stored files themselves stay
   *  in the office store, so deliverables keep resolving their tokens. One
   *  row can back several cards (quantity>1): the DB row is the unit, so
   *  removing one card removes the whole run. The delete is DEFERRED to the
   *  undo window — undo just reloads; expiry deletes the row. */
  function removeEntry(entry: HistoryEntry) {
    setResults((prev) => prev.filter((e) => e.jobId !== entry.jobId));
    let deleted = false;
    const drop = () => {
      if (deleted) return;
      deleted = true;
      void call("generation_job_delete", { jobId: entry.jobId }).catch(() => undefined);
    };
    toast(t("generator.resultRemoved"), {
      action: {
        label: t("common.undo"),
        onClick: refreshResults,
      },
      onDismiss: drop,
      onAutoClose: drop,
    });
  }

  const sizeRatio = gcd(size.width, size.height);
  const canGenerate =
    configured === true &&
    !running &&
    (needsSource ? sourceImage != null : true) &&
    (workflowId === "img2img:upscale" || prompt.trim().length > 0);
  /** Why Generate is disabled — stated under the footer so a greyed button
   *  is never a dead end. Mirrors `canGenerate`'s order; null when ready. */
  const imageBlockedReason = canGenerate
    ? null
    : configured !== true
      ? t("generator.keyMissingBody")
      : needsSource && !sourceImage
        ? t("generator.sourceImageRequired")
        : workflowId !== "img2img:upscale" && prompt.trim().length === 0
          ? t("generator.promptRequired")
          : null;

  /** AIR URNs already in the stack — keeps ModelBrowser clicks idempotent. */
  const addedLoraAirs = useMemo(() => new Set(loras.map((l) => l.air)), [loras]);

  /** Results masonry density — four across on a wide window, like the old grid. */
  const resultCols = useColumnCount(4);

  /** civitai's ecosystem picker groups: the current workflow's own ecosystem
   *  list first ("Workflow Compatible"), the rest under "All" — picking one of
   *  those retargets the workflow through `switchEcosystem`
   *  (selectorCoherence) and is marked as such. No second group = every
   *  ecosystem serves the workflow (civitai's `hasIncompatibleItems`). */
  const ecoPickerGroups = useMemo<PickerGroup[]>(() => {
    const compatible = new Set(ecosystemsForWorkflow(workflowId));
    const sections = [
      {
        id: "compatible",
        label: t("generator.ecosystemCompatible"),
        ecos: ECOSYSTEMS.filter((e) => compatible.has(e.id)),
      },
    ];
    const others = ECOSYSTEMS.filter((e) => !compatible.has(e.id));
    if (others.length > 0) {
      sections.push({ id: "all", label: t("generator.ecosystemAll"), ecos: others });
    }
    return sections.map((section) => ({
      id: section.id,
      label: section.label,
      items: section.ecos.map((e) => {
        const available = isWorkflowAvailable(workflowId, e.id);
        const target = WORKFLOWS.find((w) => w.id === targetWorkflowForEcosystem(e.id))?.label;
        return {
          id: e.id,
          label: e.label,
          selected: e.id === ecoId,
          onSelect: () => {
            setEcoOpen(false);
            if (e.id !== ecoId) switchEcosystem(e.id);
          },
          tile: <ModelTile cover={covers[e.id]?.url} eco={e} size={20} />,
          retargets: !available,
          title:
            available || !target
              ? undefined
              : t("generator.willSwitchTo", { workflow: target ?? t("generator.workflow") }),
        };
      }),
    }));
  }, [covers, ecoId, switchEcosystem, t, workflowId]);

  /** The workflow card's menu: every workflow, entries the current ecosystem
   *  can't serve dimmed but still selectable (coherence retargets the eco). */
  const workflowPickerItems = useMemo<PickerItem[]>(
    () =>
      WORKFLOWS.map((w) => {
        const compatible = isWorkflowAvailable(w.id, ecoId);
        return {
          id: w.id,
          label: w.label,
          note: w.description,
          selected: w.id === workflowId,
          onSelect: () => {
            setWfOpen(false);
            if (w.id !== workflowId) switchWorkflow(w.id);
          },
          retargets: !compatible,
          title: compatible ? undefined : t("generator.willSwitchTo", { workflow: eco.label }),
        };
      }),
    [eco.label, ecoId, switchWorkflow, t, workflowId],
  );

  const form = (
    <div className="flex flex-col gap-3 p-3">
      {/* Engine family for this lane — the mode bar owns lane switching. */}
      <EcoPicker
        ecoAriaLabel={t("generator.ecosystem")}
        ecoGroups={ecoPickerGroups}
        ecoLabel={eco.label}
        ecoOpen={ecoOpen}
        onEcoOpenChange={setEcoOpen}
      />
      <KeyStatusNotices configured={configured} />

      {/* Workflow — civitai's selected-workflow card: big bold title +
          description, opening the workflow menu (label + description rows,
          check on the active entry, entries the ecosystem can't serve
          dimmed — still selectable, coherence retargets the ecosystem). */}
      <PickerMenu
        align="start"
        ariaLabel={t("generator.workflow")}
        groups={[{ id: "workflows", items: workflowPickerItems }]}
        onOpenChange={setWfOpen}
        open={wfOpen}
        trigger={
          <>
            <div className="min-w-0 flex-1 text-left">
              <div className="text-foreground truncate text-xl font-bold">{workflow.label}</div>
              <div className="text-muted-foreground truncate text-sm">{workflow.description}</div>
            </div>
            <span
              className={cn(
                "text-muted-foreground mr-1 flex shrink-0 items-center transition-transform",
                wfOpen && "rotate-180",
              )}
            >
              <Icon name="chevron-down" />
            </span>
          </>
        }
        triggerClassName={cn(
          "flex w-full items-center gap-2 rounded-[12px] border bg-secondary p-4 transition-colors hover:brightness-110",
          wfOpen && "border-primary",
        )}
        triggerWidth
      />

      {/* Hires-fix input mode — civitai's Text to Image | Image to Image
          segmented control inside the workflow */}
      {workflowId === "txt2img:hires-fix" && (
        <div className="flex gap-1.5">
          {(
            [
              ["text", "generator.textToImage"],
              ["image", "generator.imageToImage"],
            ] as const
          ).map(([mode, key]) => (
            <ChoiceChip active={hiresMode === mode} className="flex-1" key={mode} onClick={() => setHiresMode(mode)}>
              {t(key)}
            </ChoiceChip>
          ))}
        </div>
      )}
      {/* The prompt sits directly under the workflow card — it is the one
          required field, and it used to render eighth, below the model and
          LoRA pickers, where a 400px column pushed it out of view. */}
      {!isUpscale && (
        <div className="flex flex-col gap-1.5">
          <Label
            className="text-muted-foreground flex items-center gap-1 text-[13px] font-medium"
            htmlFor="generator-prompt"
          >
            {t("generator.prompt")}
            <span className="text-destructive" title="required">
              *
            </span>
          </Label>
          <Textarea
            className="min-h-24 resize-none rounded-[8px] text-sm"
            id="generator-prompt"
            maxLength={10000}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("generator.promptPlaceholder")}
            value={prompt}
          />
          {/* Negative prompt — folded away by default. It is optional, rarely
              used, and its own full-height textarea used to push Size,
              Quantity and Advanced off a 400px screen. The trigger carries a
              filled-state marker so a set value is never hidden. The label is
              phrased as the outcome ("Exclude from image") rather than the
              model parameter, so a first-time user can tell what the field is
              for without knowing the term. */}
          <Collapsible onOpenChange={setNegativeOpen} open={negativeOpen}>
            <CollapsibleTrigger className="group mt-1 flex items-center gap-1 text-[13px] font-medium text-muted-foreground">
              <Icon className="size-4 transition-transform group-data-[state=open]:rotate-180" name="chevron-down" />{" "}
              {t("generator.negativePromptTitle")}
              <span className="text-muted-foreground/70 text-xs">· {t("generator.negativePromptOptional")}</span>
              {negativePrompt.trim().length > 0 && (
                <span className="bg-primary size-1.5 shrink-0 rounded-full" title={t("generator.negativePromptSet")} />
              )}
            </CollapsibleTrigger>
            <CollapsibleContent className="flex flex-col gap-1.5 pt-1.5">
              <p className="text-muted-foreground text-xs">{t("generator.negativePromptHint")}</p>
              <Textarea
                className="min-h-16 resize-none rounded-[8px]"
                id="generator-negative"
                maxLength={10000}
                onChange={(e) => setNegativePrompt(e.target.value)}
                placeholder={t("generator.negativePromptPlaceholder")}
                value={negativePrompt}
              />
            </CollapsibleContent>
          </Collapsible>
        </div>
      )}

      {/* Source image — required by image-input workflows (and hires-fix in
          its Image-to-Image mode); strength slider rides the variant legs,
          upscale passes ride the upscale-backed ones. */}
      {needsSource && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("generator.sourceImage")}</Label>
          {sourceImage ? (
            <div className="flex items-center gap-2 rounded-[8px] border bg-secondary p-2">
              <img alt="" className="size-12 rounded-[6px] object-cover" src={sourceImage} />
              <button
                className="text-primary text-[11px] underline-offset-2 hover:underline"
                onClick={() => {
                  setSourceImage(null);
                  setSourceDims(null);
                }}
                type="button"
              >
                {t("generator.removeImage")}
              </button>
            </div>
          ) : (
            <label className="text-muted-foreground flex cursor-pointer items-center justify-center gap-2 rounded-[8px] border border-dashed p-4 text-xs transition-colors hover:brightness-125">
              <Icon className="size-4" name="image" />
              {t("generator.chooseImage")}
              <input
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => {
                    if (typeof reader.result !== "string") return;
                    setSourceImage(reader.result);
                    // civitai rule: an img2img variant's output size follows
                    // the source image (aspectRatio depends on images).
                    const img = new Image();
                    img.onload = () => setSourceDims({ width: img.naturalWidth, height: img.naturalHeight });
                    img.src = reader.result;
                  };
                  reader.readAsDataURL(file);
                  e.target.value = "";
                }}
                type="file"
              />
            </label>
          )}
        </div>
      )}
      {(isImg2Img || hiresImg) && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <Label className="text-muted-foreground text-[13px] font-medium">{t("generator.strength")}</Label>
            <span className="text-muted-foreground/70 text-[10px]">{Number(strength).toFixed(2)}</span>
          </div>
          <Slider
            value={[Number(strength)]}
            max={1}
            min={0}
            step={0.05}
            onValueChange={(v) => setStrength(String(v[0]))}
          >
            <SliderTrack>
              <SliderRange />
            </SliderTrack>
            <SliderThumb aria-label={t("generator.strength")} />
          </Slider>
        </div>
      )}
      {(workflowId === "txt2img:hires-fix" || workflowId === "img2img:upscale") && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <Label className="text-muted-foreground text-[13px] font-medium">{t("generator.upscaleRepeats")}</Label>
            <span className="text-muted-foreground/70 text-[10px]">{t("generator.upscaleRepeatsHint")}</span>
          </div>
          <div className="flex gap-1.5">
            {[1, 2, 3].map((n) => (
              <ChoiceChip active={upscaleRepeats === n} className="flex-1" key={n} onClick={() => setUpscaleRepeats(n)}>
                {n}×
              </ChoiceChip>
            ))}
          </div>
          {workflowId === "txt2img:hires-fix" && (
            <span className="text-muted-foreground/70 text-[10px]">{t("generator.hiresHint")}</span>
          )}
        </div>
      )}

      {/* Model — clicking opens the browser in the results pane */}
      {!isUpscale && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <Label className="text-muted-foreground text-[13px] font-medium">{t("generator.model")}</Label>
            {selectedModel ? (
              <button
                className="text-primary text-[11px] underline-offset-2 hover:underline"
                onClick={() => setSelectedModel(null)}
                type="button"
              >
                {t("generator.useDefault", { model: eco.label })}
              </button>
            ) : null}
          </div>
          <button
            className="flex w-full items-center gap-2.5 rounded-[8px] border bg-secondary p-2 text-left transition-colors hover:brightness-110"
            onClick={() => {
              setPickerType("Checkpoint");
              setBrowserOpen(true);
            }}
            type="button"
          >
            <ModelTile cover={selectedModel?.coverUrl ?? covers[eco.id]?.url} eco={eco} size={40} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="text-foreground truncate text-sm font-semibold">
                  {selectedModel?.name ?? eco.label}
                </span>
                <span
                  className={cn(
                    "shrink-0 rounded border px-1 py-px text-[10px] uppercase",
                    selectedModel ? "text-warning" : "text-muted-foreground/70",
                  )}
                >
                  {selectedModel ? t("generator.customBadge") : t("generator.defaultBadge")}
                </span>
              </div>
              <div className="text-muted-foreground truncate text-xs">
                {selectedModel ? `${eco.label} · ${t("generator.customBadge")}` : `${eco.label} · ${eco.note}`}
              </div>
            </div>
            <Icon className="mr-1 size-4 shrink-0" name="chevrons-up-down" />
          </button>
        </div>
      )}

      {/* Additional Resources — civitai's LoRA section: always visible,
          counter against its 9-slot cap, Add opens the model browser */}
      {!isUpscale && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Label className="text-muted-foreground text-[13px] font-medium">
                {t("generator.additionalResources")}
              </Label>
              <span className="text-muted-foreground/70 rounded border px-1 py-px text-[10px]">
                {loras.length}/{MAX_LORAS}
              </span>
            </div>
            <button
              className="text-primary flex items-center gap-1 text-[11px] underline-offset-2 hover:underline"
              onClick={() => {
                setPickerType("LORA");
                setBrowserOpen(true);
              }}
              type="button"
            >
              <Icon className="size-3" name="plus" /> {t("generator.addLora")}
            </button>
          </div>
          {loras.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {loras.map((lora) => (
                <span
                  className="flex items-center gap-1 rounded-full border border-primary bg-secondary px-2 py-0.5 text-[11px]"
                  key={lora.id}
                >
                  <Icon className="size-3" name="zap" />
                  <span className="max-w-40 truncate">{lora.name ?? lora.air}</span>
                  <button
                    aria-label={t("generator.removeLora")}
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => setLoras((prev) => prev.filter((l) => l.id !== lora.id))}
                    type="button"
                  >
                    <Icon className="size-3" name="x" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Aspect ratio chips — hidden for upscale (output dims follow the
          source); img2img defaults them from the source image */}
      {!isUpscale && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium">{t("generator.size")}</Label>
          <div className="flex flex-wrap gap-1.5">
            {eco.sizes.map((s, i) => (
              <AspectChip
                active={sizeIdx === i && !templateSize}
                height={s.height}
                key={`${s.width}x${s.height}`}
                label={s.label}
                onClick={() => {
                  setSizeIdx(i);
                  setTemplateSize(null);
                }}
                sub={`${s.width}×${s.height}`}
                width={s.width}
              />
            ))}
          </div>
          <p className="text-muted-foreground text-[11px]">
            {isImg2Img && sourceDims
              ? `${genSize.width}×${genSize.height}px · ${t("generator.followsSource")}`
              : `${size.width}×${size.height}px`}
          </p>
        </div>
      )}

      {/* Quantity — meaningless for the upscale recipe (seed
          rides the Advanced section, civitai's layout) */}
      {!isUpscale && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-muted-foreground text-[13px] font-medium" htmlFor="generator-quantity">
            {t("generator.quantity")}
          </Label>
          <NumberStepper
            decrementLabel={t("generator.quantityDecrease")}
            id="generator-quantity"
            incrementLabel={t("generator.quantityIncrease")}
            max={12}
            min={1}
            onChange={setQuantity}
            value={quantity}
          />
          <p className="text-muted-foreground/70 text-[10px]">{t("generator.quantityHint", { max: 12 })}</p>
        </div>
      )}

      {/* Advanced */}
      {!isUpscale && (
        <Collapsible onOpenChange={setAdvancedOpen} open={advancedOpen}>
          <CollapsibleTrigger className="group text-muted-foreground flex items-center gap-1 text-[13px] font-medium">
            <Icon className="size-4 transition-transform group-data-[state=open]:rotate-180" name="chevron-down" />{" "}
            {t("generator.advanced")}
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-3 pt-2">
            <AdvancedSection
              cfgScale={cfgScale}
              seed={seed}
              steps={steps}
              sampler={sampler}
              clipSkip={clipSkip}
              sdFamily={isSdFamily(eco.id)}
              onCfgScale={setCfgScale}
              onSeed={setSeed}
              onSteps={setSteps}
              onSampler={setSampler}
              onClipSkip={setClipSkip}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );

  return (
    <GeneratorLayout
      footer={
        <GenerateFooter
          canSubmit={canGenerate}
          disabledReason={imageBlockedReason}
          note={t("generator.estimateNote", {
            width: genSize.width,
            height: genSize.height,
            ratio: `${Math.round(genSize.width / sizeRatio)}:${Math.round(genSize.height / sizeRatio)}`,
          })}
          onSubmit={() => void handleGenerate()}
          quote={quotedTokens}
          quoteState={prompt.trim().length > 0 || workflowId === "img2img:upscale" ? "quoted" : "idle"}
          submitting={running}
          submittingLabel={t("generator.generatingElapsed", { seconds: elapsed })}
          submitLabel={t("generator.generate")}
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
        {results.length === 0 && !running ? (
          <TemplateGallery cols={resultCols} onApply={applyTemplate} />
        ) : (
          <Masonry
            cols={resultCols}
            items={results}
            keyOf={(entry) => entry.fileId}
            render={(entry) => (
              <ResultCard entry={entry} onRemove={() => removeEntry(entry)} onReuse={() => reuseEntry(entry)} />
            )}
          />
        )}
      </div>
      {/* The browser overlays the results instead of replacing them — picking
          a model or LoRA no longer makes the user's media disappear. */}
      <Dialog onOpenChange={setBrowserOpen} open={browserOpen}>
        <ModelBrowser
          eco={eco}
          onAddLora={(row) => {
            setLoras((prev) => {
              // Defensive: ModelBrowser already blocks re-adds, but
              // guard the state update itself against races.
              if (prev.some((l) => l.air === row.airUrn) || prev.length >= MAX_LORAS) return prev;
              return [...prev, { id: crypto.randomUUID(), air: row.airUrn, strength: "1", name: row.name }];
            });
            setAdvancedOpen(true);
          }}
          onSelectModel={(model) => {
            setSelectedModel(model);
            // A checkpoint is a single pick — done, so close and return the
            // user to their results. LoRAs stack, so that tab stays open.
            if (pickerType === "Checkpoint") setBrowserOpen(false);
          }}
          onTypeChange={setPickerType}
          selectedModel={selectedModel}
          title={pickerType === "LORA" ? t("generator.typeLora") : t("generator.browseModels")}
          type={pickerType}
          addedLoraAirs={addedLoraAirs}
          loraCount={loras.length}
        />
      </Dialog>
    </GeneratorLayout>
  );
}

/**
 * The media surface the mode bar opens. The four lanes are fully separate
 * panels (own form state, own results storage) and exactly one mounts at a
 * time — a lane's in-flight job survives a switch because it lives in
 * localStorage and its poll loop resumes from that record on remount.
 */
export function GeneratorPage({ lane }: { lane: MediaMode }) {
  if (lane === "video") return <VideoGenerator />;
  if (lane === "audio") return <MusicGenerator />;
  if (lane === "model3d") return <Model3dGenerator />;
  return <ImageGenerator />;
}

/**
 * The image lane's empty state: community showcase images from ALL
 * ecosystems (unfiltered — each tile belongs to the ecosystem it was drawn
 * from), meta-carrying images only. Clicking a preset fills the form
 * (prompt/negative/steps/cfg/sampler + size) and switches the panel to the
 * preset's ecosystem. A failed or empty gallery degrades to the plain
 * empty state.
 */
function TemplateGallery({ cols, onApply }: { cols: number; onApply: (preset: TemplatePreset) => void }) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<TemplatePreset[] | null>(null);

  useEffect(() => {
    let alive = true;
    setPresets(null);
    call<TemplatePreset[]>("civitai_template_gallery")
      .then((list) => {
        if (alive) setPresets(Array.isArray(list) ? list : []);
      })
      .catch(() => {
        if (alive) setPresets([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (presets === null) {
    return (
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
        {(["a", "b", "c", "d", "e", "f", "g", "h"] as const).map((k) => (
          <Skeleton key={k} className="aspect-[3/4] w-full rounded-lg" />
        ))}
      </div>
    );
  }
  if (presets.length === 0) {
    return <EmptyResults description={t("generator.noResultsHint")} title={t("generator.noResults")} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs">{t("generator.templatesHint")}</p>
      <Masonry
        cols={cols}
        items={presets}
        keyOf={(p) => p.url}
        render={(p) => (
          <button
            type="button"
            onClick={() => onApply(p)}
            title={p.modelName ? `${p.modelName} — ${p.prompt}` : p.prompt}
            className="group relative block w-full cursor-pointer overflow-hidden rounded-lg border border-transparent transition-colors hover:border-ring"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.url} alt="" loading="lazy" className="w-full" />
          </button>
        )}
      />
    </div>
  );
}
