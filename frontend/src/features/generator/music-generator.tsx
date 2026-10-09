import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider, SliderRange, SliderThumb, SliderTrack } from "@/components/ui/slider";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Icon } from "@/components/shared/icon";
import { cn } from "@/lib/utils";
import { call } from "@/lib/api";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { useFilePreview } from "@/lib/preview-file";
import { useI18n } from "@/hooks/use-i18n";
import { MUSIC_STARTERS, type MusicStarter } from "./music-starters";
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
import {
  ChoiceChip,
  detailLine,
  EcoPicker,
  GeneratorLayout,
  JobCard,
  resultMeta,
  ResultsPaneHeader,
} from "./generator-shell";
import { ResultActions, mediaToken } from "./result-actions";
import type { MusicGenParams } from "@/generated/api-types";

/** Civitai musicGen request — the generated wire contract
 *  (`civitai::MusicGenParams`, specta in-place derive) narrowed with
 *  the form's literal unions. `prompt` is a frontend-only hint the
 *  Rust struct does not carry (serde drops it; the backend drafts
 *  caption/lyrics from it before building the real request). */
type MusicGenRequest = MusicGenParams & {
  ecosystem: MusicEcosystemId;
  mode?: MusicMode;
  operation?: MusicOperation;
  prompt?: string;
  scoreMode?: MusicScoreMode;
  model?: MusicAceVariant;
};

interface MusicStatusView extends LaneStatusView {
  audioUrl?: string;
}

interface SavedAudio {
  fileId: string;
  name: string;
}

interface MusicResultEntry extends LaneResultEntry<ReusableMusicReq> {
  ecosystem: MusicEcosystemId;
}

/** The `MusicGenRequest` behind a result, minus the uploaded cover art — a
 *  base64 data URL has no business in localStorage. `hadCover` records that
 *  the run consumed one. */
type ReusableMusicReq = Omit<MusicGenRequest, "coverImage"> & { hadCover?: boolean };

function stripMusicReq(req: MusicGenRequest): ReusableMusicReq {
  const { coverImage, ...rest } = req;
  return coverImage ? { ...rest, hadCover: true } : rest;
}

const JOB_KEY = "kawai-generator-music-job-v1";

/** History row → result entry (one track per run). */
function musicEntriesFromJob(row: GenerationJobRow): MusicResultEntry[] {
  let req: ReusableMusicReq = {} as ReusableMusicReq;
  try {
    req = JSON.parse(row.paramsJson || "{}") as ReusableMusicReq;
  } catch {
    // A row with an unparseable snapshot still lists its audio.
  }
  const primary = row.files.find((f) => !f.thumb);
  if (!primary) return [];
  return [
    {
      fileId: primary.id,
      name: primary.name,
      jobId: row.id,
      prompt: (req.prompt ?? req.caption ?? "").trim(),
      ecosystem: (req.ecosystem ?? DEFAULT_MUSIC_ECOSYSTEM) as MusicEcosystemId,
      at: row.createdAt * 1000,
      req,
    },
  ];
}

interface ModelCover {
  ecosystem: string;
  label: string;
  url: string | null;
  modelName: string | null;
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
        fileId={entry.fileId}
        fileName={entry.name}
        label={entry.prompt || entry.name}
        meta={resultMeta(
          entry.at,
          detailLine(entry.req?.duration ? `${entry.req.duration}s` : undefined, entry.req?.mode),
        )}
        onRemove={onRemove}
        onReuse={onReuse}
        token={mediaToken(entry.prompt, entry.fileId, entry.name)}
      />
    </div>
  );
}

/** One `civitai_music_template_gallery` preset — a community music prompt
 *  with the cover art civitai posted alongside it. */
interface MusicTemplatePreset {
  thumbnail: string;
  caption: string;
  steps: number | null;
  cfgScale: number | null;
  sampler: string | null;
}

/**
 * The music lane's empty state: community prompts from civitai when the
 * engine has any, plus the local curated starters — which always render.
 *
 * The two are complementary, not redundant. Civitai's music pool is thin
 * and lopsided (24 genuine prompts across 4 engines; Sonilo has none), so
 * a gallery-only empty state leaves that engine looking broken. The
 * starters are cheap, cover every engine unconditionally, and teach the
 * structured `caption` shape a user would otherwise never guess. A failed
 * lookup is reported as its own state instead of quietly rendering the
 * starters as if there were no community clips.
 */
function MusicTemplateGallery({
  ecosystem,
  onApplyCommunity,
  onApplyStarter,
}: {
  ecosystem: string;
  onApplyCommunity: (preset: MusicTemplatePreset) => void;
  onApplyStarter: (starter: MusicStarter) => void;
}) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<MusicTemplatePreset[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setPresets(null);
    setFailed(false);
    call<MusicTemplatePreset[]>("civitai_music_template_gallery", { ecosystem })
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

  const starters = MUSIC_STARTERS[ecosystem] ?? [];
  return (
    <div className="flex flex-col gap-4">
      {presets === null ? (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {(["a", "b", "c", "d", "e", "f"] as const).map((k) => (
            <Skeleton className="aspect-square w-full rounded-lg" key={k} />
          ))}
        </div>
      ) : presets.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs">{t("musicGenerator.presetsHint")}</p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {presets.map((preset) => (
              <button
                className="border-muted-foreground/70 hover:border-ring flex cursor-pointer flex-col items-start gap-0.5 overflow-hidden rounded-lg border text-left transition-colors"
                key={preset.caption.slice(0, 80)}
                onClick={() => onApplyCommunity(preset)}
                title={preset.caption}
                type="button"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img alt="" className="aspect-square w-full object-cover" loading="lazy" src={preset.thumbnail} />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-xs">
          {failed ? t("musicGenerator.presetsUnavailable") : t("musicGenerator.presetsEmpty")}
        </p>
      )}

      {starters.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-muted-foreground text-[13px] font-medium">{t("musicGenerator.startersTitle")}</span>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {starters.map((starter) => (
              <button
                className="border-muted-foreground/70 hover:border-ring flex cursor-pointer flex-col items-start gap-0.5 rounded-lg border bg-secondary/40 p-2.5 text-left transition-colors"
                key={starter.id}
                onClick={() => onApplyStarter(starter)}
                type="button"
              >
                <span className="text-[13px] font-semibold">{starter.label}</span>
                <span className="text-muted-foreground text-[11px] leading-snug">{starter.note}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export function MusicGenerator() {
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Stepper input draft — free typing without the controlled-value clobbering
  // intermediate states like "0." (sonilo sfx steps by 0.5); committed on blur.
  const [durText, setDurText] = useState<string | null>(null);

  const isSonilo = ecoId === "sonilo";
  const isAce = ecoId === "ace";
  const isCustom = mode === "custom";
  const durRange = musicDurationRange(ecoId, isSonilo ? operation : "music");
  const durStep = durRange.step;
  const aceSteps = aceStepsRange(isAce ? variant : "xl-turbo");

  // Ecosystem/operation switches reset every dependent pick to the new
  // engine's first valid value (a stale pick would fail the whatif).
  const switchEcosystem = useCallback((id: MusicEcosystemId) => {
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
  }, []);
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

  const lane = useWorkflowLane<MusicGenRequest, ReusableMusicReq, MusicStatusView, SavedAudio, MusicResultEntry>({
    configured,
    formEffective,
    // Music refuses to submit on a failed quote — its engines have no
    // partial-price fallback the way the video/3D lanes do.
    gateOnCostError: true,
    lane: "music",
    keys: { job: JOB_KEY },
    fromJob: musicEntriesFromJob,
    ops: {
      cost: "civitai_music_cost",
      status: "civitai_music_status",
      submit: "civitai_music_submit",
      fetch: "civitai_music_fetch",
    },
    labels: { done: "musicGenerator.done", failed: "musicGenerator.failedToast" },
    stuckMs: 30 * 60 * 1000,
    buildRequest,
    strip: stripMusicReq,
    promptLabel: () => prompt.trim() || caption.trim(),
    succeeded: (st) => st.status === "succeeded" && st.audioUrl != null,
    // Fetch exactly once — the signed URL expires after download.
    fetchSaved: (st, workflowId) => call<SavedAudio>("civitai_music_fetch", { workflowId, audioUrl: st.audioUrl }),
  });
  const { cancel, cost, costError, elapsed, job, removeEntry, results, status, submit, submitting } = lane;
  const {
    groups: ecoGroups,
    open: ecoOpen,
    setOpen: setEcoOpen,
  } = useEcoGroups(MUSIC_ECOSYSTEMS, ecoId, switchEcosystem);

  async function pickCover(file: File | undefined) {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error(t("musicGenerator.coverType"));
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toast.error(t("musicGenerator.coverTooLarge"));
      return;
    }
    setCoverImage(await readFileAsDataUrl(file));
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
              <ChoiceChip
                active={variant === v.key}
                key={v.key}
                onClick={() => {
                  if (variant === v.key) return;
                  setVariant(v.key);
                  setSteps("");
                  setCfgScale("");
                }}
              >
                {v.label}
              </ChoiceChip>
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
              <ChoiceChip active={mode === m} className="flex-1" key={m} onClick={() => switchMode(m)}>
                {m === "simple" ? t("musicGenerator.simple") : t("musicGenerator.custom")}
              </ChoiceChip>
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
              <ChoiceChip active={operation === op} className="flex-1" key={op} onClick={() => switchOperation(op)}>
                {op === "music" ? t("musicGenerator.music") : t("musicGenerator.soundEffect")}
              </ChoiceChip>
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
                <ChoiceChip active={scoreMode === m} className="flex-1" key={m} onClick={() => setScoreMode(m)}>
                  {t(`musicGenerator.score_${m}`)}
                </ChoiceChip>
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
                    <ChoiceChip
                      active={seedMode === "random"}
                      className="px-2.5 py-1"
                      onClick={() => setSeedMode("random")}
                    >
                      {t("generator.seedRandom")}
                    </ChoiceChip>
                    <ChoiceChip
                      active={seedMode === "custom"}
                      className="px-2.5 py-1"
                      onClick={() => setSeedMode("custom")}
                    >
                      {t("musicGenerator.custom")}
                    </ChoiceChip>
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

  /** Where a preset's text must land depends on the lane's mode. The form
   *  opens in `simple`, which renders — and submits — a single `prompt`
   *  box; `custom` renders the per-engine `caption` (+ lyrics) fields. A
   *  preset is a ready-made prompt either way, so it goes into the field
   *  the CURRENT mode actually reads, and the toast names which one.
   *  Writing only `caption` left the visible box empty, which is why a click
   *  appeared to do nothing. */
  function applyPresetText(text: string, lyricsText: string) {
    if (isSonilo) {
      // Sonilo has a single prompt field in either mode.
      setPrompt(text);
      setLyrics("");
      toast.success(t("musicGenerator.presetApplied"));
      return;
    }
    if (isCustom) {
      setCaption(text);
      setLyrics(lyricsText);
    } else {
      setPrompt(text);
      setLyrics("");
    }
    toast.success(t("musicGenerator.presetApplied"));
  }

  /** Load a community music prompt. Steps/cfg are applied only where the
   *  engine exposes them (ACE owns cfg; YuE2/MiniMax the steps) — in simple
   *  mode the draft path derives them upstream, so sending them would be
   *  ignored anyway. */
  function applyMusicTemplate(preset: MusicTemplatePreset) {
    applyPresetText(preset.caption, "");
    if (isCustom) {
      if (preset.steps != null) setSteps(String(preset.steps));
      if (preset.cfgScale != null) setCfgScale(String(preset.cfgScale));
    }
  }

  /** Load a curated starter. A starter with lyrics fills both fields. */
  function applyMusicStarter(starter: MusicStarter) {
    applyPresetText(starter.caption, starter.lyrics ?? "");
  }

  return (
    <GeneratorLayout
      footer={
        <GenerateFooter
          canSubmit={lane.canSubmit}
          inFlight={job != null}
          inFlightLabel={t("musicGenerator.inProgress")}
          note={t("musicGenerator.costNote")}
          onSubmit={() => void submit()}
          quote={cost?.totalTokens ?? null}
          quoteState={
            costError ? "failed" : cost ? "quoted" : formEffective && configured === true ? "pending" : "idle"
          }
          ready={cost?.ready ?? true}
          submitting={submitting}
          submittingLabel={t("musicGenerator.submitting")}
          submitLabel={t("generator.generate")}
          warnings={cost?.warnings ?? []}
        />
      }
      form={form}
      header={
        <ResultsPaneHeader
          meta={t("generator.resultsCount", { count: results.length })}
          title={t("musicGenerator.results")}
        />
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-auto p-3 lg:overscroll-contain">
        {job && (
          <div className="mb-3">
            <JobCard
              cancelLabel={t("musicGenerator.cancel")}
              elapsed={elapsed}
              error={status?.error}
              onCancel={cancel}
              queuePosition={status?.queuePosition}
              statusLabel={t(laneStatusKey("musicGenerator", status))}
              workflowId={job.workflowId}
            />
          </div>
        )}
        {results.length === 0 && !job ? (
          <MusicTemplateGallery
            ecosystem={ecoId}
            onApplyCommunity={applyMusicTemplate}
            onApplyStarter={applyMusicStarter}
          />
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
    </GeneratorLayout>
  );
}
