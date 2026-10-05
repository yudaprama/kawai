import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { AssetShell } from "@/features/assets/components/asset-shell";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";
import { call, errText } from "@/lib/api";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { useFilePreview } from "@/lib/preview-file";
import { useI18n } from "@/hooks/use-i18n";
import {
  type GenParams,
  type SavedImage,
  type SearchModelPage,
  type SearchModelRow,
  DEFAULT_WORKFLOW,
  ECOSYSTEMS,
  WORKFLOWS,
  ecosystemsForWorkflow,
  estimateBuzz,
  isWorkflowAvailable,
  resolveCompatibleEcosystem,
  targetWorkflowForEcosystem,
} from "./ecosystems";
import { C } from "./palette";
import { AdvancedSection } from "./advanced-section";

interface HistoryEntry {
  fileId: string;
  name: string;
  prompt: string;
  at: number;
}

interface ModelCover {
  ecosystem: string;
  label: string;
  url: string | null;
  modelName: string | null;
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

const HISTORY_KEY = "kawai-generator-results-v1";
const MAX_HISTORY = 50;
/** Civitai's additional-resources slot cap mirrored in the panel header. */
const MAX_LORAS = 9;

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** 1 / 2 / 3 columns by viewport (pane tracks the app window). */
function useColumnCount(): number {
  const [cols, setCols] = useState(3);
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 639px)");
    const medium = window.matchMedia("(max-width: 1023px)");
    const update = () => setCols(narrow.matches ? 1 : medium.matches ? 2 : 3);
    update();
    narrow.addEventListener("change", update);
    medium.addEventListener("change", update);
    return () => {
      narrow.removeEventListener("change", update);
      medium.removeEventListener("change", update);
    };
  }, []);
  return cols;
}

function compactCount(n: number | null): string {
  if (n === null) return "";
  return new Intl.NumberFormat("en", { notation: "compact" }).format(n);
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/** Text segmented control — the results pane's Hasil|Model switch. */
function PaneTabs({ value, onChange }: { value: "hasil" | "model"; onChange: (v: "hasil" | "model") => void }) {
  const { t } = useI18n();
  const tabs = [
    { id: "hasil" as const, label: t("generator.results") },
    { id: "model" as const, label: t("generator.model") },
  ];
  return (
    <div className="inline-flex shrink-0 items-center rounded-[8px] p-0.5" style={{ backgroundColor: C.input }}>
      {tabs.map((tab) => (
        <button
          className="flex h-7 items-center rounded-[6px] px-3 text-xs font-medium transition-colors"
          key={tab.id}
          onClick={() => onChange(tab.id)}
          style={{
            backgroundColor: value === tab.id ? C.border : "transparent",
            color: value === tab.id ? C.heading : C.muted,
          }}
          type="button"
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
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
      className="flex w-[70px] flex-col items-center gap-1.5 rounded-[8px] border p-2 transition-colors"
      onClick={onClick}
      style={{
        backgroundColor: C.input,
        borderColor: active ? C.blue : C.border,
        color: active ? C.heading : C.muted,
      }}
      type="button"
    >
      <div className="flex h-6 items-center justify-center">
        <div
          className="rounded-[3px]"
          style={{
            height: Math.max(6, height * scale),
            width: Math.max(6, width * scale),
            backgroundColor: active ? C.blue : C.muted,
          }}
        />
      </div>
      <span className="text-[10px] leading-none font-medium">{label}</span>
      <span className="text-[9px] leading-none" style={{ color: C.faint }}>
        {sub}
      </span>
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

/** One saved result: cover thumbnail, hover actions, click opens preview. */
function ResultCard({ entry }: { entry: HistoryEntry }) {
  const { t } = useI18n();
  const { data, isLoading } = useFilePreview({ id: entry.fileId, name: entry.name });
  return (
    <div
      className="group relative overflow-hidden rounded-[8px] border"
      style={{ backgroundColor: C.input, borderColor: C.border }}
    >
      <button
        className="block w-full cursor-zoom-in"
        onClick={() => emitOpenPreview(entry.fileId, entry.name)}
        title={entry.prompt}
        type="button"
      >
        {isLoading ? (
          <div className="flex aspect-square items-center justify-center">
            <Spinner className="size-5" />
          </div>
        ) : (
          <img
            alt={entry.prompt}
            className="aspect-square w-full object-cover transition-transform duration-200 group-hover:scale-[1.03]"
            src={data?.dataUrl}
          />
        )}
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-between gap-1 bg-gradient-to-t from-black/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
        <span className="line-clamp-1 text-[11px] text-white/90">{entry.prompt || entry.name}</span>
        <Button
          aria-label={t("generator.copyToken")}
          className="size-6 shrink-0 hover:bg-white/20"
          onClick={() => {
            const token = `![${entry.prompt.slice(0, 48) || entry.name}](kawai-file://${entry.fileId})`;
            void navigator.clipboard.writeText(token);
            toast.success(t("generator.copied"));
          }}
          size="icon"
          title={t("generator.copyToken")}
          variant="ghost"
        >
          <Icon className="size-3.5 text-white" name="copy" />
        </Button>
      </div>
    </div>
  );
}

/** Rich resource card for the in-pane browser — civitai's model-card look:
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
      className="group overflow-hidden rounded-[10px] border text-left transition-colors hover:brightness-110"
      style={{
        backgroundColor: C.input,
        borderColor: selected ? C.blue : C.border,
        boxShadow: selected ? `0 0 0 1px ${C.blue}` : undefined,
      }}
    >
      <div className="relative w-full overflow-hidden" style={{ backgroundColor: C.deep }}>
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
                <span
                  className="size-1.5 rounded-full"
                  key={url}
                  style={{ backgroundColor: i === at ? C.buzz : "rgba(255,255,255,0.4)" }}
                />
              ))}
            </div>
          </>
        )}
      </div>
      <div className="flex flex-col gap-1 p-2.5">
        <div className="flex items-start justify-between gap-2">
          <span className="line-clamp-1 text-[13px] font-semibold" style={{ color: C.heading }}>
            {row.name}
          </span>
          {selected && <Icon className="mt-0.5 size-3.5 shrink-0" name="check" />}
        </div>
        <span className="text-[11px]" style={{ color: C.muted }}>
          {row.creator ?? "—"}
          {row.downloads !== null && <span> · {compactCount(row.downloads)} ⬇</span>}
          {row.thumbsUp !== null && <span style={{ color: C.buzz }}> · {compactCount(row.thumbsUp)} ❤</span>}
        </span>
        {row.description && (
          <span className="line-clamp-2 text-[11px] leading-snug" style={{ color: C.faint }}>
            {row.description}
          </span>
        )}
        {row.baseModel && (
          <span
            className="w-fit rounded border px-1 py-px text-[10px]"
            style={{ borderColor: C.border, color: C.faint }}
          >
            {row.baseModel}
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * The in-pane model browser (where the civitai picker modal's content lives
 * now — the RESULTS pane gives it room for full model info). Same fetch +
 * selection behavior: Checkpoint click selects the diffuser override, LoRA
 * click adds to the stack.
 */
function ModelBrowser({
  eco,
  onAddLora,
  onSelectModel,
  selectedModel,
  type,
  onTypeChange,
  addedLoraAirs,
  loraCount,
}: {
  eco: (typeof ECOSYSTEMS)[number];
  onAddLora: (row: SearchModelRow) => void;
  onSelectModel: (model: SelectedModel | null) => void;
  selectedModel: SelectedModel | null;
  type: "Checkpoint" | "LORA";
  onTypeChange: (type: "Checkpoint" | "LORA") => void;
  /** AIR URNs already in the LoRA stack — re-clicking one is a no-op. */
  addedLoraAirs: Set<string>;
  loraCount: number;
}) {
  const { t } = useI18n();
  const cols = useColumnCount();
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

  // Page 1 (replace) — every filter change restarts the feed.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRows([]);
    setNextCursor(null);
    call<SearchModelPage>("civitai_search_models", {
      ecosystem: eco.id,
      query: debouncedQuery || undefined,
      modelType: type,
      sort,
      limit: 24,
    })
      .then((page) => {
        if (!cancelled) setRows(page.rows);
        if (!cancelled) setNextCursor(page.nextCursor);
      })
      .catch((e) => {
        if (!cancelled) {
          setRows([]);
          setError(errText(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [eco.id, type, debouncedQuery, sort]);

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
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Filters: search + type tabs + sort */}
      <div className="flex flex-wrap items-center gap-2 border-b p-3" style={{ borderColor: C.border }}>
        <div className="relative min-w-[180px] flex-1">
          <Icon className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2" name="search" />
          <Input
            className="h-8 rounded-[8px] pr-3 text-sm focus-visible:ring-0"
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("generator.searchPlaceholder")}
            style={{
              backgroundColor: C.input,
              borderColor: C.border,
              color: C.text,
              paddingLeft: 32,
            }}
            value={query}
          />
        </div>
        <div className="inline-flex items-center rounded-[8px] p-0.5" style={{ backgroundColor: C.input }}>
          {(["Checkpoint", "LORA"] as const).map((tt) => (
            <button
              className="flex h-7 items-center rounded-[6px] px-2.5 text-xs font-medium transition-colors"
              key={tt}
              onClick={() => onTypeChange(tt)}
              style={{
                backgroundColor: type === tt ? C.border : "transparent",
                color: type === tt ? C.heading : C.muted,
              }}
              type="button"
            >
              {tt === "Checkpoint" ? t("generator.typeCheckpoint") : t("generator.typeLora")}
            </button>
          ))}
        </div>
        <Select onValueChange={setSort} value={sort}>
          <SelectTrigger
            className="h-8 w-[170px] rounded-[8px] text-xs"
            style={{ backgroundColor: C.input, borderColor: C.border, color: C.text }}
          >
            {sortOptions.find((o) => o.value === sort)?.label}
          </SelectTrigger>
          <SelectContent
            className="z-[60] rounded-[8px] border"
            position="popper"
            style={{ backgroundColor: C.input, borderColor: C.border }}
          >
            {sortOptions.map((o) => (
              <SelectItem
                className="rounded-[6px] focus:bg-[#2C2E33] focus:text-white"
                key={o.value}
                style={{ color: C.text }}
                value={o.value}
              >
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Grid */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3" onScroll={handleScroll}>
        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : error ? (
          <div
            className="mx-auto flex h-40 max-w-md flex-col items-center justify-center gap-2 rounded-[8px] border p-4 text-center"
            style={{ borderColor: C.border, color: C.muted }}
          >
            <Icon className="size-8 stroke-1" name="alert-triangle" />
            <p className="text-xs break-words">{error}</p>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-40 flex-col items-center justify-center gap-2" style={{ color: C.muted }}>
            <Icon className="size-12 stroke-1" name="inbox" />
            <p className="text-sm">{t("generator.noResults")}</p>
          </div>
        ) : (
          (() => {
            // True masonry: round-robin distribution into N flowing columns —
            // cards keep natural heights, no row-sync gaps.
            const columns: SearchModelRow[][] = Array.from({ length: cols }, () => []);
            rows.forEach((row, i) => {
              columns[i % cols].push(row);
            });
            return (
              <div className="flex items-start gap-2">
                {columns.map((col, ci) => (
                  <div className="flex min-w-0 flex-1 flex-col gap-2" key={`col-${col[0]?.modelId ?? `empty-${ci}`}`}>
                    {col.map((row) => (
                      <BrowserCard
                        eco={eco}
                        key={row.modelId}
                        onSelect={handleSelect}
                        row={row}
                        selected={
                          type === "Checkpoint" ? selectedModel?.airUrn === row.airUrn : addedLoraAirs.has(row.airUrn)
                        }
                      />
                    ))}
                  </div>
                ))}
              </div>
            );
          })()
        )}
        {loadingMore && (
          <div className="flex justify-center py-3">
            <Spinner className="size-5" />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Generator — Civitai image generation styled as a faithful copy of the
 * civitai generation panel (their exact dark palette, Mantine-dark control
 * treatment, cover-art model picker, Buzz footer). The model BROWSER lives
 * in the wide results pane (tab Hasil|Model) so full model info fits.
 * Direct-op path (no supervisor); the op is synchronous and spends Buzz —
 * the Generate click is the consent. Results land in the office store and
 * embed anywhere `kawai-file://` tokens render. The API key is vault-baked.
 */
export function GeneratorPage({ onBack }: { onBack: () => void }) {
  const { t } = useI18n();
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [paneTab, setPaneTab] = useState<"hasil" | "model">("hasil");
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
  const [prompt, setPrompt] = useState("");
  const [negativePrompt, setNegativePrompt] = useState("");
  const [quantity, setQuantity] = useState(1);
  const [seed, setSeed] = useState("");
  const [cfgScale, setCfgScale] = useState(String(ECOSYSTEMS[0].defaultCfgScale));
  const [steps, setSteps] = useState(String(ECOSYSTEMS[0].defaultSteps));
  const [loras, setLoras] = useState<LoraEntry[]>([]);

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<HistoryEntry[]>(loadHistory);
  const resultsRef = useRef(results);
  resultsRef.current = results;
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Key status + cover art (vault key presence check; covers = v1 reads).
  useEffect(() => {
    call<{ configured: boolean }>("civitai_api_key_status")
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(false));
    call<ModelCover[]>("civitai_model_covers")
      .then((list) => {
        const map: Record<string, ModelCover> = {};
        for (const c of list) map[c.ecosystem] = c;
        if (aliveRef.current) setCovers(map);
      })
      .catch(() => undefined);
  }, []);

  const size = eco.sizes[sizeIdx] ?? eco.sizes[0];
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
  const genSize =
    (isImg2Img || hiresImg) && sourceDims
      ? {
          width: Math.min(2048, Math.max(64, Math.round(sourceDims.width / 16) * 16)),
          height: Math.min(2048, Math.max(64, Math.round(sourceDims.height / 16) * 16)),
        }
      : size;
  const parsedSteps = Number(steps);
  // Buzz pricing is a per-pixel/per-step generation formula — the upscale
  // recipe exposes no cost fields, so no estimate is shown there.
  const estimate = useMemo(() => {
    if (isUpscale) return 0;
    return estimateBuzz({
      width: genSize.width,
      height: genSize.height,
      steps: Number.isFinite(parsedSteps) ? parsedSteps : undefined,
      quantity,
    });
  }, [isUpscale, genSize, parsedSteps, quantity]);

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
      negativePrompt: negativePrompt.trim() || undefined,
      cfgScale: Number(cfgScale),
      steps: Number(steps),
      seed: seed.trim() ? Number(seed) : undefined,
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
  function switchEcosystem(id: string) {
    if (!isWorkflowAvailable(workflowId, id)) {
      setWorkflowId(targetWorkflowForEcosystem(id));
    }
    setEcoId(id);
    setSizeIdx(0);
    setSelectedModel(null);
    const next = ECOSYSTEMS.find((e) => e.id === id);
    if (next) {
      setCfgScale(String(next.defaultCfgScale));
      setSteps(String(next.defaultSteps));
    }
  }

  function switchWorkflow(id: string) {
    setWorkflowId(id);
    const compatible = resolveCompatibleEcosystem(id, ecoId);
    if (compatible !== ecoId) {
      switchEcosystem(compatible);
      return;
    }
  }

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
    setPaneTab("hasil");
    try {
      const saved = await call<SavedImage[]>("civitai_generate", { params });
      const entries: HistoryEntry[] = saved.map((f) => ({
        fileId: f.fileId,
        name: f.name,
        prompt: params.prompt,
        at: Date.now(),
      }));
      const next = [...entries, ...resultsRef.current].slice(0, MAX_HISTORY);
      setResults(next);
      localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      toast.success(t("generator.done", { count: saved.length }));
    } catch (e) {
      toast.error(`${t("generator.failed")}: ${errText(e)}`);
    } finally {
      if (aliveRef.current) setRunning(false);
    }
  }

  const sizeRatio = gcd(size.width, size.height);
  const canGenerate =
    configured === true &&
    !running &&
    (needsSource ? sourceImage != null : true) &&
    (workflowId === "img2img:upscale" || prompt.trim().length > 0);
  const inputStyle = { backgroundColor: C.input, borderColor: C.border, color: C.text } as const;

  /** AIR URNs already in the stack — keeps ModelBrowser clicks idempotent. */
  const addedLoraAirs = useMemo(() => new Set(loras.map((l) => l.air)), [loras]);

  /** civitai's ecosystem picker tabs, stacked for a dropdown: the current
   *  workflow's own ecosystem list first ("Workflow Compatible"), the rest
   *  under "All" — picking one of those retargets the workflow through
   *  `switchEcosystem` (selectorCoherence). Empty second group = every
   *  ecosystem serves the workflow (civitai's `hasIncompatibleItems`). */
  const ecoSections = useMemo(() => {
    const compatible = new Set(ecosystemsForWorkflow(workflowId));
    const groups = [
      {
        id: "compatible",
        label: t("generator.ecosystemCompatible"),
        ecos: ECOSYSTEMS.filter((e) => compatible.has(e.id)),
      },
    ];
    const others = ECOSYSTEMS.filter((e) => !compatible.has(e.id));
    if (others.length > 0) {
      groups.push({ id: "all", label: t("generator.ecosystemAll"), ecos: others });
    }
    return groups;
  }, [workflowId, t]);

  const form = (
    <div className="flex flex-col gap-3 p-3">
      {/* Top bar — civitai's [media tabs …… Eco | <ecosystem>] strip. The
          panel is image-only, so the media tabs render as a static island. */}
      {!isUpscale && (
        <div
          className="flex items-center justify-between gap-2 rounded-[10px] border p-1.5"
          style={{ backgroundColor: C.surface, borderColor: C.border }}
        >
          <div className="flex items-center gap-1 rounded-[8px] border p-1" style={{ borderColor: C.border }}>
            {["image", "video", "music", "box"].map((n, i) => (
              <span
                className="flex h-7 w-9 items-center justify-center rounded-[6px]"
                key={n}
                style={{
                  backgroundColor: i === 0 ? C.hover : undefined,
                  color: i === 0 ? C.blue : C.faint,
                }}
              >
                <Icon name={n} />
              </span>
            ))}
          </div>
          <div className="relative">
            <button
              aria-expanded={ecoOpen}
              aria-haspopup="listbox"
              className="flex items-center gap-2 rounded-[8px] px-3 py-2 text-sm font-semibold transition-colors hover:brightness-125"
              onClick={() => setEcoOpen((v) => !v)}
              style={{ color: C.heading }}
              type="button"
            >
              <span style={{ color: C.muted }}>Eco</span>
              <span className="h-4 w-px" style={{ backgroundColor: C.border }} />
              {eco.label}
              <span
                className="flex items-center transition-transform"
                style={{ transform: ecoOpen ? "rotate(180deg)" : undefined, color: C.muted }}
              >
                <Icon name="chevron-down" />
              </span>
            </button>
            {ecoOpen && (
              <div
                className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded-[10px] border shadow-xl"
                role="listbox"
                style={{ backgroundColor: C.hover, borderColor: C.border }}
              >
                {ecoSections.map((section) => (
                  <div className="border-t first:border-t-0" key={section.id} style={{ borderColor: C.border }}>
                    <div
                      className="px-3 pt-2.5 pb-1 text-[10px] font-semibold tracking-wider uppercase"
                      style={{ color: C.faint }}
                    >
                      {section.label}
                    </div>
                    {section.ecos.map((e) => {
                      const selected = e.id === ecoId;
                      const available = isWorkflowAvailable(workflowId, e.id);
                      const targetLabel = available
                        ? undefined
                        : (WORKFLOWS.find((w) => w.id === targetWorkflowForEcosystem(e.id))?.label ??
                          t("generator.workflow"));
                      return (
                        <button
                          aria-selected={selected}
                          className="flex w-full items-center gap-2 p-2.5 text-left transition-colors hover:brightness-125"
                          key={e.id}
                          onClick={() => {
                            setEcoOpen(false);
                            if (!selected) switchEcosystem(e.id);
                          }}
                          role="option"
                          style={{
                            backgroundColor: selected ? `${C.blue}22` : undefined,
                            opacity: available ? 1 : 0.6,
                          }}
                          title={targetLabel ? t("generator.willSwitchTo", { workflow: targetLabel }) : undefined}
                          type="button"
                        >
                          <ModelTile cover={covers[e.id]?.url} eco={e} size={20} />
                          <span
                            className="flex-1 truncate text-sm font-medium"
                            style={{ color: selected ? C.blue : C.heading }}
                          >
                            {e.label}
                          </span>
                          {selected ? (
                            <span className="shrink-0" style={{ color: C.blue }}>
                              <Icon name="check" />
                            </span>
                          ) : !available ? (
                            <span className="shrink-0" style={{ color: C.muted }}>
                              <Icon className="size-3.5" name="arrow-right" />
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      {ecoOpen && <div aria-hidden className="fixed inset-0 z-20" onClick={() => setEcoOpen(false)} />}
      {configured === false && (
        <div
          className="flex items-start gap-2 rounded-[8px] border p-2.5 text-xs leading-relaxed"
          style={{ backgroundColor: C.input, borderColor: C.border, color: C.muted }}
        >
          <Icon className="mt-0.5 size-4 shrink-0" name="info" />
          <span>{t("generator.keyMissingBody")}</span>
        </div>
      )}
      {configured === null && (
        <div className="flex items-center gap-2 text-sm" style={{ color: C.muted }}>
          <Spinner className="size-4" /> {t("generator.checkingKey")}
        </div>
      )}

      {/* Workflow — civitai's selected-workflow card: big bold title +
          description, opening the workflow menu (label + description rows,
          check on the active entry, entries the ecosystem can't serve
          dimmed — still selectable, coherence retargets the ecosystem). */}
      <div className="relative">
        <button
          aria-expanded={wfOpen}
          aria-haspopup="listbox"
          className="flex w-full items-center gap-2 rounded-[12px] border p-4 text-left transition-colors hover:brightness-110"
          onClick={() => setWfOpen((v) => !v)}
          style={{ backgroundColor: C.input, borderColor: wfOpen ? C.blue : C.border }}
          type="button"
        >
          <div className="min-w-0 flex-1">
            <div className="truncate text-xl font-bold" style={{ color: C.heading }}>
              {workflow.label}
            </div>
            <div className="truncate text-sm" style={{ color: C.muted }}>
              {workflow.description}
            </div>
          </div>
          <span
            className="mr-1 flex shrink-0 items-center transition-transform"
            style={{ transform: wfOpen ? "rotate(180deg)" : undefined, color: C.muted }}
          >
            <Icon name="chevron-down" />
          </span>
        </button>
        {wfOpen && (
          <div
            className="absolute inset-x-0 top-full z-30 mt-1 overflow-hidden rounded-[10px] border shadow-xl"
            role="listbox"
            style={{ backgroundColor: C.hover, borderColor: C.border }}
          >
            {WORKFLOWS.map((w) => {
              const compatible = isWorkflowAvailable(w.id, ecoId);
              const selected = w.id === workflowId;
              return (
                <button
                  aria-selected={selected}
                  className="flex w-full items-start gap-2 p-2.5 text-left transition-colors hover:brightness-125"
                  key={w.id}
                  onClick={() => {
                    setWfOpen(false);
                    if (!selected) switchWorkflow(w.id);
                  }}
                  role="option"
                  style={{
                    backgroundColor: selected ? `${C.blue}22` : undefined,
                    opacity: compatible ? 1 : 0.45,
                  }}
                  type="button"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold" style={{ color: selected ? C.blue : C.heading }}>
                      {w.label}
                    </div>
                    <div className="truncate text-xs" style={{ color: C.muted }}>
                      {w.description}
                    </div>
                  </div>
                  {selected && (
                    <span className="mt-1 shrink-0" style={{ color: C.blue }}>
                      <Icon name="check" />
                    </span>
                  )}
                </button>
              );
            })}
            {/* click-away backdrop */}
          </div>
        )}
      </div>
      {wfOpen && <div aria-hidden className="fixed inset-0 z-20" onClick={() => setWfOpen(false)} />}

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
            <button
              aria-pressed={hiresMode === mode}
              className="flex-1 rounded-[8px] border px-2.5 py-1.5 text-xs font-medium transition-colors"
              key={mode}
              onClick={() => setHiresMode(mode)}
              style={{
                backgroundColor: hiresMode === mode ? C.hover : C.input,
                borderColor: hiresMode === mode ? C.blue : C.border,
                color: hiresMode === mode ? C.blue : C.muted,
              }}
              type="button"
            >
              {t(key)}
            </button>
          ))}
        </div>
      )}

      {/* Source image — required by image-input workflows (and hires-fix in
          its Image-to-Image mode); strength slider rides the variant legs,
          upscale passes ride the upscale-backed ones. */}
      {needsSource && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
            {t("generator.sourceImage")}
          </Label>
          {sourceImage ? (
            <div
              className="flex items-center gap-2 rounded-[8px] border p-2"
              style={{ backgroundColor: C.input, borderColor: C.border }}
            >
              <img alt="" className="size-12 rounded-[6px] object-cover" src={sourceImage} />
              <button
                className="text-[11px] underline-offset-2 hover:underline"
                onClick={() => {
                  setSourceImage(null);
                  setSourceDims(null);
                }}
                style={{ color: C.blue }}
                type="button"
              >
                {t("generator.removeImage")}
              </button>
            </div>
          ) : (
            <label
              className="flex cursor-pointer items-center justify-center gap-2 rounded-[8px] border border-dashed p-4 text-xs transition-colors hover:brightness-125"
              style={{ borderColor: C.border, color: C.muted }}
            >
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
            <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
              {t("generator.strength")}
            </Label>
            <span className="text-[10px]" style={{ color: C.faint }}>
              {Number(strength).toFixed(2)}
            </span>
          </div>
          <input
            className="w-full accent-[var(--color-text)]"
            max={1}
            min={0}
            onChange={(e) => setStrength(e.target.value)}
            step={0.05}
            type="range"
            value={strength}
          />
        </div>
      )}
      {(workflowId === "txt2img:hires-fix" || workflowId === "img2img:upscale") && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
              {t("generator.upscaleRepeats")}
            </Label>
            <span className="text-[10px]" style={{ color: C.faint }}>
              {t("generator.upscaleRepeatsHint")}
            </span>
          </div>
          <div className="flex gap-1.5">
            {[1, 2, 3].map((n) => (
              <button
                aria-pressed={upscaleRepeats === n}
                className="flex-1 rounded-[8px] border px-2.5 py-1.5 text-xs font-medium transition-colors"
                key={n}
                onClick={() => setUpscaleRepeats(n)}
                style={{
                  backgroundColor: upscaleRepeats === n ? C.hover : C.input,
                  borderColor: upscaleRepeats === n ? C.blue : C.border,
                  color: upscaleRepeats === n ? C.heading : C.muted,
                }}
                type="button"
              >
                {n}×
              </button>
            ))}
          </div>
          {workflowId === "txt2img:hires-fix" && (
            <span className="text-[10px]" style={{ color: C.faint }}>
              {t("generator.hiresHint")}
            </span>
          )}
        </div>
      )}

      {/* Model — clicking opens the browser in the results pane */}
      {!isUpscale && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline justify-between">
            <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
              {t("generator.model")}
            </Label>
            {selectedModel ? (
              <button
                className="text-[11px] underline-offset-2 hover:underline"
                onClick={() => setSelectedModel(null)}
                style={{ color: C.blue }}
                type="button"
              >
                {t("generator.useDefault", { model: eco.label })}
              </button>
            ) : null}
          </div>
          <button
            className="flex w-full items-center gap-2.5 rounded-[8px] border p-2 text-left transition-colors hover:brightness-110"
            onClick={() => {
              setPickerType("Checkpoint");
              setPaneTab("model");
            }}
            style={{ backgroundColor: C.input, borderColor: C.border }}
            type="button"
          >
            <ModelTile cover={selectedModel?.coverUrl ?? covers[eco.id]?.url} eco={eco} size={40} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <span className="truncate text-sm font-semibold" style={{ color: C.heading }}>
                  {selectedModel?.name ?? covers[eco.id]?.modelName ?? eco.label}
                </span>
                <span
                  className="shrink-0 rounded border px-1 py-px text-[9px] uppercase"
                  style={{ borderColor: C.border, color: selectedModel ? C.buzz : C.faint }}
                >
                  {selectedModel ? t("generator.customBadge") : t("generator.defaultBadge")}
                </span>
              </div>
              <div className="truncate text-xs" style={{ color: C.muted }}>
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
              <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
                {t("generator.additionalResources")}
              </Label>
              <span className="rounded border px-1 py-px text-[9px]" style={{ borderColor: C.border, color: C.faint }}>
                {loras.length}/{MAX_LORAS}
              </span>
            </div>
            <button
              className="flex items-center gap-1 text-[11px] underline-offset-2 hover:underline"
              onClick={() => {
                setPickerType("LORA");
                setPaneTab("model");
              }}
              style={{ color: C.blue }}
              type="button"
            >
              <Icon className="size-3" name="plus" /> {t("generator.addLora")}
            </button>
          </div>
          {loras.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {loras.map((lora) => (
                <span
                  className="flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
                  key={lora.id}
                  style={{ backgroundColor: C.input, borderColor: C.blue, color: C.text }}
                >
                  <Icon className="size-3" name="zap" />
                  <span className="max-w-40 truncate">{lora.name ?? lora.air}</span>
                  <button
                    aria-label={t("generator.removeLora")}
                    className="hover:text-white"
                    onClick={() => setLoras((prev) => prev.filter((l) => l.id !== lora.id))}
                    style={{ color: C.muted }}
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

      {/* Prompt — civitai's "Prompt ⓘ *": plain empty textarea, required
          marker, no counter */}
      {!isUpscale && (
        <div className="flex flex-col gap-1.5">
          <Label
            className="flex items-center gap-1 text-[13px] font-medium"
            htmlFor="generator-prompt"
            style={{ color: C.muted }}
          >
            {t("generator.prompt")}
            <span style={{ color: "#e03131" }} title="required">
              *
            </span>
          </Label>
          <Textarea
            className="min-h-24 resize-none rounded-[8px] text-sm focus-visible:ring-0"
            id="generator-prompt"
            maxLength={10000}
            onChange={(e) => setPrompt(e.target.value)}
            onFocus={(e) => (e.currentTarget.style.borderColor = C.blue)}
            onBlur={(e) => (e.currentTarget.style.borderColor = C.border)}
            style={inputStyle}
            value={prompt}
          />
        </div>
      )}

      {/* Negative Prompt — civitai renders it directly under Prompt, not
          buried in Advanced */}
      {!isUpscale && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-[13px] font-medium" htmlFor="generator-negative" style={{ color: C.muted }}>
            {t("generator.negativePrompt")}
          </Label>
          <Textarea
            className="min-h-16 resize-none rounded-[8px] focus-visible:ring-0"
            id="generator-negative"
            maxLength={10000}
            onChange={(e) => setNegativePrompt(e.target.value)}
            onFocus={(e) => (e.currentTarget.style.borderColor = C.blue)}
            onBlur={(e) => (e.currentTarget.style.borderColor = C.border)}
            style={inputStyle}
            value={negativePrompt}
          />
        </div>
      )}

      {/* Aspect ratio chips — hidden for upscale (output dims follow the
          source); img2img defaults them from the source image */}
      {!isUpscale && (
        <div className="flex flex-col gap-1.5">
          <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
            {t("generator.size")}
          </Label>
          <div className="flex flex-wrap gap-1.5">
            {eco.sizes.map((s, i) => (
              <AspectChip
                active={sizeIdx === i}
                height={s.height}
                key={`${s.width}x${s.height}`}
                label={s.label}
                onClick={() => setSizeIdx(i)}
                sub={`${s.width}×${s.height}`}
                width={s.width}
              />
            ))}
          </div>
          <p className="text-[11px]" style={{ color: C.muted }}>
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
          <Label className="text-[13px] font-medium" htmlFor="generator-quantity" style={{ color: C.muted }}>
            {t("generator.quantity")}
          </Label>
          <Input
            className="h-8 rounded-[8px] focus-visible:ring-0"
            id="generator-quantity"
            max={12}
            min={1}
            onChange={(e) => setQuantity(Math.max(1, Math.min(12, Number(e.target.value) || 1)))}
            style={inputStyle}
            type="number"
            value={quantity}
          />
        </div>
      )}

      {/* Advanced */}
      {!isUpscale && (
        <Collapsible onOpenChange={setAdvancedOpen} open={advancedOpen}>
          <CollapsibleTrigger className="flex items-center gap-1 text-[13px] font-medium" style={{ color: C.muted }}>
            <Icon className="size-4" name="chevron-down" /> {t("generator.advanced")}
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-3 pt-2">
            <AdvancedSection
              cfgScale={cfgScale}
              seed={seed}
              steps={steps}
              onCfgScale={setCfgScale}
              onSeed={setSeed}
              onSteps={setSteps}
            />
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );

  return (
    <AssetShell subtitle={t("generator.subtitle")} title={t("generator.title")} onBack={onBack}>
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        {/* ── Form column — the civitai generation panel, always dark ── */}
        <section
          className="flex w-full shrink-0 flex-col border-b lg:w-[400px] lg:border-r lg:border-b-0"
          style={{ backgroundColor: C.surface, borderColor: C.border }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto">{form}</div>
          {/* Footer — civitai's [Buzz pill][Generate] arrangement */}
          <div className="border-t p-3" style={{ borderColor: C.border }}>
            <div className="flex items-stretch gap-2">
              {!isUpscale && (
                <div
                  className="flex h-10 shrink-0 items-center gap-1 rounded-[8px] border px-2.5"
                  style={{ backgroundColor: C.input, borderColor: C.border }}
                  title={t("generator.estimate")}
                >
                  <Icon className="size-3.5 text-[#FFD43B]" name="zap" />
                  <span className="text-[13px] font-semibold" style={{ color: C.buzz }}>
                    ≈{estimate.toFixed(1)}
                  </span>
                </div>
              )}
              <Button
                className="h-10 flex-1 rounded-[8px] text-[15px] font-semibold text-white hover:brightness-110"
                disabled={!canGenerate}
                onClick={() => void handleGenerate()}
                style={{ backgroundColor: running ? C.blueHover : C.blue }}
              >
                {running ? (
                  <span className="flex items-center gap-2">
                    <Spinner className="size-4" />
                    {t("generator.generatingElapsed", { seconds: elapsed })}
                  </span>
                ) : (
                  t("generator.generate")
                )}
              </Button>
            </div>
            {!isUpscale && (
              <p className="mt-1.5 text-center text-[10px]" style={{ color: C.faint }}>
                {t("generator.estimateNote", {
                  width: genSize.width,
                  height: genSize.height,
                  ratio: `${Math.round(genSize.width / sizeRatio)}:${Math.round(genSize.height / sizeRatio)}`,
                })}
              </p>
            )}
          </div>
        </section>

        {/* ── Results pane — Hasil | Model browser ── */}
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col border-t lg:border-t-0"
          style={{ backgroundColor: C.deep, borderColor: C.border }}
        >
          <div className="flex items-center justify-between gap-2 border-b px-3 py-2" style={{ borderColor: C.border }}>
            <PaneTabs onChange={setPaneTab} value={paneTab} />
            <span className="truncate text-[11px]" style={{ color: C.muted }}>
              {paneTab === "hasil"
                ? t("generator.resultsCount", { count: results.length })
                : `${size.width}×${size.height} · ${eco.label}`}
            </span>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            {paneTab === "model" ? (
              <div className="flex h-full flex-col" style={{ backgroundColor: C.surface }}>
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
                  onSelectModel={setSelectedModel}
                  onTypeChange={setPickerType}
                  selectedModel={selectedModel}
                  type={pickerType}
                  addedLoraAirs={addedLoraAirs}
                  loraCount={loras.length}
                />
              </div>
            ) : (
              <div className="h-full overflow-y-auto p-3">
                {results.length === 0 ? (
                  <div
                    className="flex h-full flex-col items-center justify-center gap-2 text-center"
                    style={{ color: C.muted }}
                  >
                    <Icon className="size-16 stroke-1" name="inbox" />
                    <p className="text-sm font-medium" style={{ color: C.text }}>
                      {t("generator.noResults")}
                    </p>
                    <p className="max-w-56 text-xs">{t("generator.noResultsHint")}</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                    {results.map((entry) => (
                      <ResultCard entry={entry} key={entry.fileId} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </AssetShell>
  );
}
