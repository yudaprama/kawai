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
  estimateBuzz,
  isWorkflowAvailable,
  resolveCompatibleEcosystem,
  targetWorkflowForEcosystem,
} from "./ecosystems";

/**
 * The civitai generation panel's exact Mantine-dark palette (their
 * tailwind.config.js `dark` + `yellow` scales) — the panel is ALWAYS dark,
 * an island of the civitai look inside whatever theme kawai runs.
 */
const C = {
  surface: "#1A1B1E", // dark-7 — panel bg
  deep: "#141517", // dark-8 — results pane bg
  input: "#25262B", // dark-6 — controls bg
  hover: "#2C2E33", // dark-5 — hover bg
  border: "#373A40", // dark-4 — borders
  text: "#C1C2C5", // dark-0 — body text
  muted: "#8c8fa3", // dark-2 — secondary text
  faint: "#5C5F66", // dark-3 — disabled text
  heading: "#f8f9fa", // gray-0 — headings
  buzz: "#FFD43B", // yellow-4 — Buzz currency color
  blue: "#4263EB", // generate button
  blueHover: "#3B5BDB",
} as const;

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
  width,
}: {
  active: boolean;
  height: number;
  label: string;
  onClick: () => void;
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
}: {
  eco: (typeof ECOSYSTEMS)[number];
  onAddLora: (row: SearchModelRow) => void;
  onSelectModel: (model: SelectedModel | null) => void;
  selectedModel: SelectedModel | null;
  type: "Checkpoint" | "LORA";
  onTypeChange: (type: "Checkpoint" | "LORA") => void;
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
                        selected={type === "Checkpoint" && selectedModel?.airUrn === row.airUrn}
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
  const parsedSteps = Number(steps);
  const estimate = useMemo(
    () =>
      estimateBuzz({
        width: size.width,
        height: size.height,
        steps: Number.isFinite(parsedSteps) ? parsedSteps : undefined,
        quantity,
      }),
    [size, parsedSteps, quantity],
  );

  const buildParams = useCallback((): GenParams => {
    const cleanedLoras = loras
      .map((l) => ({ air: l.air.trim(), strength: Number(l.strength) || 1 }))
      .filter((l) => l.air.length > 0);
    return {
      ecosystem: eco.id,
      engine: eco.engine,
      workflow: workflowId,
      prompt: prompt.trim(),
      width: size.width,
      height: size.height,
      quantity,
      negativePrompt: negativePrompt.trim() || undefined,
      cfgScale: Number(cfgScale),
      steps: Number(steps),
      seed: seed.trim() ? Number(seed) : undefined,
      loras: cleanedLoras.length > 0 ? cleanedLoras : undefined,
      diffuserModel: selectedModel?.airUrn,
    };
  }, [eco, workflowId, size, prompt, negativePrompt, quantity, cfgScale, steps, seed, loras, selectedModel]);

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
    if (params.prompt.length === 0) {
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
  const canGenerate = configured === true && prompt.trim().length > 0 && !running;
  const inputStyle = { backgroundColor: C.input, borderColor: C.border, color: C.text } as const;

  const form = (
    <div className="flex flex-col gap-3 p-3">
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

      {/* Workflow — txt2img runs everywhere, img2img sdcpp-only (registry).
          Switching retargets the ecosystem when incompatible (coherence). */}
      <div className="flex gap-1.5">
        {WORKFLOWS.map((w) => (
          <button
            aria-pressed={workflowId === w.id}
            className="flex-1 rounded-[8px] border px-2.5 py-1.5 text-xs font-medium transition-colors"
            key={w.id}
            onClick={() => switchWorkflow(w.id)}
            style={{
              backgroundColor: workflowId === w.id ? C.hover : C.input,
              borderColor: workflowId === w.id ? C.blue : C.border,
              color: workflowId === w.id ? C.heading : C.muted,
            }}
            type="button"
          >
            {w.label}
          </button>
        ))}
      </div>

      {/* Ecosystem chips — the quick family switch */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
          {t("generator.ecosystem")}
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {ECOSYSTEMS.map((e) => (
            <button
              aria-pressed={ecoId === e.id}
              className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors"
              key={e.id}
              onClick={() => switchEcosystem(e.id)}
              style={{
                backgroundColor: ecoId === e.id ? C.hover : C.input,
                borderColor: ecoId === e.id ? C.blue : C.border,
                color: ecoId === e.id ? C.heading : C.muted,
                opacity: isWorkflowAvailable(workflowId, e.id) ? 1 : 0.45,
              }}
              type="button"
            >
              <ModelTile cover={covers[e.id]?.url} eco={e} size={16} />
              {e.label}
            </button>
          ))}
        </div>
      </div>

      {/* Model — clicking opens the browser in the results pane */}
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

      {/* Active LoRA chips — always visible, even with Advanced collapsed */}
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

      {/* Prompt */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-baseline justify-between">
          <Label className="text-[13px] font-medium" htmlFor="generator-prompt" style={{ color: C.muted }}>
            {t("generator.prompt")}
          </Label>
          <span className="text-[10px]" style={{ color: C.faint }}>
            {prompt.length}/10000
          </span>
        </div>
        <Textarea
          className="min-h-24 resize-none rounded-[8px] text-sm focus-visible:ring-0"
          id="generator-prompt"
          maxLength={10000}
          onChange={(e) => setPrompt(e.target.value)}
          onFocus={(e) => (e.currentTarget.style.borderColor = C.blue)}
          onBlur={(e) => (e.currentTarget.style.borderColor = C.border)}
          placeholder={t("generator.promptPlaceholder")}
          style={inputStyle}
          value={prompt}
        />
      </div>

      {/* Aspect ratio chips */}
      <div className="flex flex-col gap-1.5">
        <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
          {t("generator.size")}
        </Label>
        <div className="flex flex-wrap gap-1.5">
          {eco.sizes.map((s, i) => {
            const ratio = gcd(s.width, s.height);
            return (
              <AspectChip
                active={sizeIdx === i}
                height={s.height}
                key={`${s.width}x${s.height}`}
                label={`${Math.round(s.width / ratio)}:${Math.round(s.height / ratio)}`}
                onClick={() => setSizeIdx(i)}
                width={s.width}
              />
            );
          })}
        </div>
        <p className="text-[11px]" style={{ color: C.muted }}>
          {size.width}×{size.height}px
        </p>
      </div>

      {/* Quantity + seed */}
      <div className="grid grid-cols-2 gap-2">
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
        <div className="flex flex-col gap-1.5">
          <Label className="text-[13px] font-medium" htmlFor="generator-seed" style={{ color: C.muted }}>
            {t("generator.seed")}
          </Label>
          <Input
            className="h-8 rounded-[8px] focus-visible:ring-0"
            id="generator-seed"
            onChange={(e) => setSeed(e.target.value)}
            placeholder={t("generator.seedPlaceholder")}
            style={inputStyle}
            value={seed}
          />
        </div>
      </div>

      {/* Advanced */}
      <Collapsible onOpenChange={setAdvancedOpen} open={advancedOpen}>
        <CollapsibleTrigger className="flex items-center gap-1 text-[13px] font-medium" style={{ color: C.muted }}>
          <Icon className="size-4" name="chevron-down" /> {t("generator.advanced")}
        </CollapsibleTrigger>
        <CollapsibleContent className="flex flex-col gap-3 pt-2">
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
          <div className="grid grid-cols-2 gap-2">
            <div className="flex flex-col gap-1.5">
              <Label className="text-[13px] font-medium" htmlFor="generator-cfg" style={{ color: C.muted }}>
                {t("generator.cfgScale")}
              </Label>
              <Input
                className="h-8 rounded-[8px] focus-visible:ring-0"
                id="generator-cfg"
                max={30}
                min={0}
                onChange={(e) => setCfgScale(e.target.value)}
                step="0.5"
                style={inputStyle}
                type="number"
                value={cfgScale}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-[13px] font-medium" htmlFor="generator-steps" style={{ color: C.muted }}>
                {t("generator.steps")}
              </Label>
              <Input
                className="h-8 rounded-[8px] focus-visible:ring-0"
                id="generator-steps"
                max={150}
                min={1}
                onChange={(e) => setSteps(e.target.value)}
                style={inputStyle}
                type="number"
                value={steps}
              />
            </div>
          </div>
          {/* LoRA stack — browser (named) or manual AIR URN paste */}
          <div className="flex flex-col gap-1.5">
            <Label className="text-[13px] font-medium" style={{ color: C.muted }}>
              {t("generator.loras")}
            </Label>
            {loras.map((lora) => (
              <div className="flex items-center gap-2" key={lora.id}>
                <Input
                  className="h-8 flex-1 rounded-[8px] text-xs focus-visible:ring-0"
                  onChange={(e) =>
                    setLoras((prev) => prev.map((l) => (l.id === lora.id ? { ...l, air: e.target.value } : l)))
                  }
                  placeholder="urn:air:anima:lora:civitai:123456@789012"
                  style={inputStyle}
                  value={lora.name ?? lora.air}
                />
                <Input
                  className="h-8 w-16 rounded-[8px] text-xs focus-visible:ring-0"
                  max={4}
                  min={0}
                  onChange={(e) =>
                    setLoras((prev) => prev.map((l) => (l.id === lora.id ? { ...l, strength: e.target.value } : l)))
                  }
                  step="0.1"
                  style={inputStyle}
                  type="number"
                  value={lora.strength}
                />
                <Button
                  aria-label={t("generator.removeLora")}
                  className="size-8 hover:brightness-125"
                  onClick={() => setLoras((prev) => prev.filter((l) => l.id !== lora.id))}
                  size="icon"
                  style={{ backgroundColor: C.input, color: C.muted }}
                  variant="ghost"
                >
                  <Icon className="size-4" name="x" />
                </Button>
              </div>
            ))}
            <Button
              className="h-8 self-start rounded-[8px] text-xs"
              disabled={running}
              onClick={() => {
                setPickerType("LORA");
                setPaneTab("model");
              }}
              size="sm"
              style={{ backgroundColor: C.input, borderColor: C.border, color: C.text }}
              variant="outline"
            >
              <Icon className="size-3.5" name="plus" /> {t("generator.addLora")}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
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
            <p className="mt-1.5 text-center text-[10px]" style={{ color: C.faint }}>
              {t("generator.estimateNote", {
                width: size.width,
                height: size.height,
                ratio: `${Math.round(size.width / sizeRatio)}:${Math.round(size.height / sizeRatio)}`,
              })}
            </p>
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
                    setLoras((prev) => [
                      ...prev,
                      { id: crypto.randomUUID(), air: row.airUrn, strength: "1", name: row.name },
                    ]);
                    setAdvancedOpen(true);
                  }}
                  onSelectModel={setSelectedModel}
                  onTypeChange={setPickerType}
                  selectedModel={selectedModel}
                  type={pickerType}
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
