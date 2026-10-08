import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { refreshTokenBalance } from "@/features/topup/use-token-balance";
import { Icon } from "@/components/shared/icon";
import { Spinner } from "@/components/ui/spinner";
import { call, errText } from "@/lib/api";
import { useI18n } from "@/hooks/use-i18n";
import { cn } from "@/lib/utils";
import type { TranslationKey } from "@/lib/i18n";
import type { PickerGroup } from "./picker-menu";
import { publishMediaDebit } from "./generate-footer";

/** Terminal-but-not-success states (lowercase wire vocabulary). */
export const TERMINAL_FAILED: Record<string, true> = { failed: true, expired: true, canceled: true };

/** Long-poll hold passed to each `*_status` op — keeps a panel near-live
 *  without hammering the consumer API. */
export const STATUS_WAIT_SECS = 15;

/** Results kept per lane (newest first). Source of truth is the backend
 *  `generation_jobs` table (migration 0023) read through the
 *  `generation_history` op — the localStorage log this replaced was
 *  per-webview, capped by storage limits, and lost on storage wipe. */
export const MAX_RESULTS = 30;

/** One stored artifact of a generation job — office-store pointer + name. */
export interface GenerationJobFile {
  id: string;
  name: string;
  /** Poster/preview render — paired with the entry before it instead of
   *  listed as its own card. */
  thumb?: boolean;
}

/** One `generation_jobs` row as `generation_history` returns it. */
export interface GenerationJobRow {
  id: string;
  lane: string;
  workflowId: string | null;
  ecosystem: string;
  workflow: string | null;
  /** The request that produced the artifacts, minus heavy source media —
   *  each lane parses it back into its own reusable-settings snapshot. */
  paramsJson: string;
  buzzCost: number | null;
  status: string;
  files: GenerationJobFile[];
  createdAt: number;
  updatedAt: number;
}

/** Lane-scoped history read (newest first). */
export function fetchGenerationHistory(lane: string, limit = MAX_RESULTS): Promise<GenerationJobRow[]> {
  return call<GenerationJobRow[]>("generation_history", { lane, limit, offset: 0 });
}

/** Debounce before the free-whatif quote fires, so typing a prompt does not
 *  emit one pricing call per keystroke. */
const QUOTE_DEBOUNCE_MS = 700;

/** Pause after a transport hiccup before the poll loop retries. */
const POLL_BACKOFF_MS = 4000;

/** Install the mount/unmount flip on an `alive` ref created by the CALLER:
 *  the `useRef(true)` binding must stay visible inside each component, or
 *  exhaustive-deps stops recognizing the value as a stable ref. Both
 *  Generator lanes (image + video) guard a long-lived in-flight job. */
export function useAliveEffect(aliveRef: { current: boolean }) {
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, [aliveRef]);
}

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** Read a picked media file as a data URL. Each lane keeps its own size/type
 *  guard + toast; this is only the FileReader dance they all repeat. */
export function readFileAsDataUrl(file: File): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const reader = new FileReader();
  reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
  reader.onerror = () => resolve(null);
  reader.readAsDataURL(file);
  return promise;
}

/** Vault-key presence for the civitai API: `null` while checking. */
export function useCivitaiKeyStatus(): boolean | null {
  const [configured, setConfigured] = useState<boolean | null>(null);
  useEffect(() => {
    call<{ configured: boolean }>("civitai_api_key_status")
      .then((s) => setConfigured(s.configured))
      .catch(() => setConfigured(false));
  }, []);
  return configured;
}

/** Inline notices under the lane's eco picker: key-missing body (`false`) or the
 *  checking spinner (`null`); nothing once configured. */
export function KeyStatusNotices({ configured }: { configured: boolean | null }) {
  const { t } = useI18n();
  if (configured === false) {
    return (
      <div className="bg-secondary text-muted-foreground flex items-start gap-2 rounded-[8px] border p-2.5 text-xs leading-relaxed">
        <Icon className="mt-0.5 size-4 shrink-0" name="info" />
        <span>{t("generator.keyMissingBody")}</span>
      </div>
    );
  }
  if (configured === null) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Spinner className="size-4" /> {t("generator.checkingKey")}
      </div>
    );
  }
  return null;
}

/** What every lane's free-whatif op returns. */
export interface LaneCostView {
  totalBuzz: number;
  /** App-token debit at submit (server-side ceil conversion). */
  totalTokens: number;
  ready: boolean;
  warnings: string[];
}

/** The status envelope every lane's long-poll op returns; each lane widens it
 *  with its own terminal payload. */
export interface LaneStatusView {
  workflowId: string;
  status: string;
  queuePosition: number | null;
  error?: string;
}

/** An in-flight workflow, persisted so a restart resumes polling. */
export interface LaneJob<Snapshot = unknown> {
  workflowId: string;
  /** History row id (`generation_jobs`) — abandoned via
   *  `generation_job_delete` when the job fails or is canceled. Absent on a
   *  job persisted by an older build. */
  jobId?: string;
  prompt: string;
  at: number;
  /** The submitting request's scalar settings, carried through to the saved
   *  artifacts so each result card can load them back into the form. Absent on
   *  a job persisted by an older build. */
  req?: Snapshot;
}

/** The shell every lane's result entry shares: what a card needs to render,
 *  plus the settings snapshot behind "Load these settings". */
export interface LaneResultEntry<Snapshot = unknown> {
  fileId: string;
  name: string;
  /** The history row this artifact belongs to — one run can produce several
   *  files (batch clips, quantity>1), and removing one card removes the row. */
  jobId: string;
  prompt: string;
  at: number;
  req?: Snapshot;
}

/** The four consumer-API ops a media lane is built from. Cancel is not here:
 *  every lane rides the workflow-generic `civitai_video_cancel`. */
interface LaneOps {
  cost: string;
  submit: string;
  status: string;
  fetch: string;
}

export interface WorkflowLaneOptions<Req, Snapshot, Status extends LaneStatusView, Saved, Entry> {
  /** Vault-key presence: `null` while checking. Gates every quote + submit. */
  configured: boolean | null;
  /** The form has everything the engine requires — the whatif (and thus the
   *  quote pill) only runs on a complete form. */
  formEffective: boolean;
  /** Music additionally refuses to submit on a failed quote. */
  gateOnCostError?: boolean;
  ops: LaneOps;
  /** The lane's history id — which slice of `generation_jobs` this panel
   *  reads (`video` | `music` | `model3d`). */
  lane: string;
  /** Only the in-flight job persists client-side (poll resume across a
   *  restart); the finished-artifact log lives in the backend DB. */
  keys: { job: string };
  /** Maps one history row onto this lane's result entries (parse
   *  `paramsJson` into the lane's reusable snapshot, extract the prompt). */
  fromJob: (row: GenerationJobRow) => Entry[];
  /** Give up on a job whose transport keeps failing after this long. */
  stuckMs: number;
  buildRequest: () => Req;
  /** The request minus any uploaded media, for the persisted snapshot. */
  strip: (req: Req) => Snapshot;
  /** The label a result card shows for this run. */
  promptLabel: () => string;
  /** The status is terminal-successful AND carries its payload. */
  succeeded: (st: Status) => boolean;
  fetchSaved: (st: Status, workflowId: string) => Promise<Saved>;
  /** Toast copy for this lane's outcomes. */
  labels: { done: TranslationKey; failed: TranslationKey };
}

export interface WorkflowLane<Snapshot, Status extends LaneStatusView, Entry> {
  cost: LaneCostView | null;
  costError: boolean;
  submitting: boolean;
  job: LaneJob<Snapshot> | null;
  status: Status | null;
  elapsed: number;
  results: Entry[];
  canSubmit: boolean;
  submit: () => Promise<void>;
  cancel: () => void;
  removeEntry: (entry: Entry) => void;
}

/**
 * The workflow lane every media generator shares: a debounced free-whatif
 * quote, submit with the display-grade balance pre-check, a long-poll loop
 * that survives transport hiccups and app restarts, an elapsed ticker, and the
 * persisted result log with its undo toast.
 *
 * Each lane supplies only its op names, its media-stripping rule, and how a
 * fetched artifact becomes result entries — its form and its `reuseEntry`
 * field mapping stay its own.
 */
export function useWorkflowLane<
  Req,
  Snapshot,
  Status extends LaneStatusView,
  Saved,
  Entry extends LaneResultEntry<Snapshot>,
>({
  configured,
  formEffective,
  gateOnCostError = false,
  ops,
  lane,
  keys,
  fromJob,
  stuckMs,
  buildRequest,
  strip,
  promptLabel,
  succeeded,
  fetchSaved,
  labels,
}: WorkflowLaneOptions<Req, Snapshot, Status, Saved, Entry>): WorkflowLane<Snapshot, Status, Entry> {
  const { t } = useI18n();
  const [cost, setCost] = useState<LaneCostView | null>(null);
  const [costError, setCostError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [job, setJob] = useState<LaneJob<Snapshot> | null>(() => loadJson<LaneJob<Snapshot> | null>(keys.job, null));
  const [status, setStatus] = useState<Status | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<Entry[]>([]);
  const aliveRef = useRef(true);
  useAliveEffect(aliveRef);

  /** The lane's per-run callbacks close over form state, so a fresh identity
   *  every render would tear down the poll loop. Park them in a ref: the loop
   *  reads the latest without ever restarting for a form change. */
  const pollRef = useRef({ succeeded, fetchSaved });
  pollRef.current = { succeeded, fetchSaved };
  const fromJobRef = useRef(fromJob);
  fromJobRef.current = fromJob;

  /** Reload the lane's history from the backend (mount, post-success, undo). */
  const refreshResults = useCallback(() => {
    fetchGenerationHistory(lane)
      .then((rows) => {
        if (aliveRef.current) setResults(rows.flatMap((r) => fromJobRef.current(r)));
      })
      .catch(() => undefined);
  }, [lane]);
  useEffect(() => {
    refreshResults();
  }, [refreshResults]);

  /** Delete a job's history row — failed/canceled runs never enter the strip
   *  (the toast already told the user; only paid-success runs are history). */
  const abandonJob = useCallback((jobId?: string) => {
    if (jobId) void call("generation_job_delete", { jobId }).catch(() => undefined);
  }, []);

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
      call<LaneCostView>(ops.cost, { req: costRequest })
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
    }, QUOTE_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [costRequest, configured, formEffective, ops.cost]);

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
    const { workflowId } = job;
    void (async () => {
      while (!cancelled) {
        try {
          const st = await call<Status>(ops.status, { workflowId, waitSecs: STATUS_WAIT_SECS });
          if (cancelled || !aliveRef.current) return;
          setStatus(st);
          if (pollRef.current.succeeded(st)) {
            await pollRef.current.fetchSaved(st, workflowId);
            if (cancelled || !aliveRef.current) return;
            // The fetch op already marked the history row `succeeded` —
            // reload it instead of maintaining a client-side log.
            refreshResults();
            localStorage.removeItem(keys.job);
            setJob(null);
            setStatus(null);
            toast.success(t(labels.done));
            return;
          }
          if (TERMINAL_FAILED[st.status]) {
            abandonJob(job.jobId);
            localStorage.removeItem(keys.job);
            setJob(null);
            toast.error(`${t(labels.failed)}: ${st.error ?? st.status}`);
            return;
          }
        } catch (e) {
          // Transport hiccup — brief pause and keep polling; the workflow
          // keeps running server-side and the job survives restarts.
          if (cancelled || !aliveRef.current) return;
          if (Date.now() - job.at > stuckMs) {
            abandonJob(job.jobId);
            localStorage.removeItem(keys.job);
            setJob(null);
            toast.error(`${t(labels.failed)}: ${errText(e)}`);
            return;
          }
          await delay(POLL_BACKOFF_MS);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [job, keys.job, labels.done, labels.failed, ops.status, refreshResults, stuckMs, t, abandonJob]);

  const canSubmit = configured === true && !submitting && !job && formEffective && !(gateOnCostError && costError);

  const submit = useCallback(async () => {
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
      const sent = buildRequest();
      const view = await call<{ workflowId: string; jobId?: string }>(ops.submit, { req: sent });
      publishMediaDebit(cost?.totalTokens ?? 0);
      const nextJob: LaneJob<Snapshot> = {
        workflowId: view.workflowId,
        jobId: view.jobId,
        prompt: promptLabel(),
        at: Date.now(),
        req: strip(sent),
      };
      localStorage.setItem(keys.job, JSON.stringify(nextJob));
      setStatus(null);
      setJob(nextJob);
    } catch (e) {
      toast.error(`${t(labels.failed)}: ${errText(e)}`);
    } finally {
      if (aliveRef.current) setSubmitting(false);
    }
  }, [buildRequest, canSubmit, cost, keys.job, labels.failed, ops.submit, promptLabel, strip, t]);

  /** Cancel reuses the video op — every media lane rides one workflow bus.
   *  The history row goes with it: a canceled spend is not history. */
  const cancel = useCallback(() => {
    if (!job) return;
    const { workflowId } = job;
    const jobId = job.jobId;
    void call("civitai_video_cancel", { workflowId })
      .catch(() => undefined)
      .finally(() => {
        abandonJob(jobId);
        localStorage.removeItem(keys.job);
        setJob(null);
        toast.success(t("videoGenerator.canceled"));
      });
  }, [job, keys.job, abandonJob, t]);

  /** Drop a run from the panel's history — the stored files themselves stay
   *  in the office store, so deliverables keep resolving their tokens. One
   *  row can back several cards (batch clips, quantity>1): the DB row is the
   *  unit, so removing one card removes the whole run. The delete is
   *  DEFERRED to the undo window — undo just reloads; expiry deletes the row. */
  const removeEntry = useCallback(
    (entry: Entry) => {
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
    },
    [refreshResults, t],
  );

  return { canSubmit, cancel, cost, costError, elapsed, job, removeEntry, results, status, submit, submitting };
}

/** The ecosystem menu every lane renders: each engine with its one-line note
 *  and a gradient letter tile. Returns the groups plus the open flag the
 *  `EcoPicker` dropdown is controlled by. */
export function useEcoGroups<E extends { id: string; label: string; note?: string; gradient: string }>(
  ecosystems: E[],
  ecoId: string,
  switchEcosystem: (id: E["id"]) => void,
): { groups: PickerGroup[]; open: boolean; setOpen: (open: boolean) => void } {
  const [open, setOpen] = useState(false);
  const groups = useMemo<PickerGroup[]>(
    () => [
      {
        id: "ecosystems",
        items: ecosystems.map((e) => ({
          id: e.id,
          label: e.label,
          note: e.note,
          selected: e.id === ecoId,
          onSelect: () => {
            setOpen(false);
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
    [ecoId, ecosystems, switchEcosystem],
  );
  return { groups, open, setOpen };
}

/** The status pill's copy for a lane's `JobCard`. Terminal-but-not-yet-fetched
 *  reads as "succeeded", because the download is the last leg of the poll
 *  loop. `prefix` is the lane's i18n namespace (`videoGenerator`, …). */
export function laneStatusKey(prefix: string, status: LaneStatusView | null): TranslationKey {
  return `${prefix}.${status?.status === "processing" ? "processing" : status?.status === "succeeded" ? "succeeded" : "queued"}` as TranslationKey;
}
