//! Civitai generation renderers: the Generator agent's flat, kind-tagged
//! envelopes.
//!
//! `civitai_image` is the one-shot image lane (files + the charged price).
//! The three workflow lanes (video / music / 3D) share ONE card: the poll
//! envelope reuses the success kind, so the branch is `files` — present
//! means stored, absent means still running. The `*_submit` receipts get
//! their own card (workflowId is the only handle a later fetch can take).
//! Foreign payloads are refused (null), never half-rendered.

import { type ReactNode } from "react";

import { FileIcon } from "@/components/shared/file-icon";
import { emitOpenPreview } from "@/lib/preview-bridge";

import { parse, isRecord, str, num, fmtNum, Footnote, MetricGrid, TextCard, type Metric } from "./shared";

/** Result kinds → the lane label the card shows. `civitai_image` routes to
 *  its own renderer; the other three share the workflow card. */
const WORKFLOW_KINDS: Record<string, string> = {
  civitai_video: "Video",
  civitai_music: "Music",
  civitai_model3d: "3D model",
};

/** The submit receipts, keyed by their own kinds. */
const SUBMIT_KINDS: Record<string, string> = {
  civitai_video_submit: "Video",
  civitai_music_submit: "Music",
  civitai_model3d_submit: "3D model",
};

/** One stored artifact — `SavedImage` / `SavedAudio` / `SavedVideo` /
 *  `SavedModel3d` all carry at least fileId + name. */
interface StoredFile {
  fileId: string;
  name: string;
}

function readFiles(v: unknown): StoredFile[] {
  if (!Array.isArray(v)) return [];
  const files: StoredFile[] = [];
  for (const f of v) {
    if (isRecord(f) && typeof f.fileId === "string") {
      files.push({ fileId: f.fileId, name: str(f.name) ?? f.fileId });
    }
  }
  return files;
}

/** A stored library artifact: click opens the app preview (the same bridge
 *  the office file cards use). */
function FileRows({ files }: { files: StoredFile[] }) {
  return (
    <div className="space-y-1.5">
      {files.map((f) => (
        <button
          key={f.fileId}
          type="button"
          onClick={() => emitOpenPreview(f.fileId, f.name)}
          title={`Open ${f.name}`}
          className="bg-card hover:bg-accent/40 flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left"
        >
          <FileIcon className="size-5 shrink-0" name={f.name} />
          <div className="min-w-0 flex-1">
            <div className="text-foreground truncate text-sm" title={f.name}>
              {f.name}
            </div>
            <div className="text-muted-foreground truncate font-mono text-[0.6875rem]" title={f.fileId}>
              {f.fileId}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}

/** `civitai_generate_image` → {kind:"civitai_image", lane:"image", ecosystem,
 *  workflow, files, buzz, tokens, note}. */
export function renderCivitaiImage(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || d.kind !== "civitai_image") return null;
  const files = readFiles(d.files);
  const metrics: Metric[] = [
    {
      label: "Cost",
      value: `${fmtNum(num(d.tokens) ?? 0)} tokens`,
      sub: `${fmtNum(num(d.buzz) ?? 0)} Buzz`,
    },
    { label: "Engine", value: str(d.ecosystem) ?? "—" },
    { label: "Workflow", value: str(d.workflow) ?? "—" },
  ];
  return (
    <TextCard>
      <MetricGrid items={metrics} />
      {files.length > 0 ? (
        <FileRows files={files} />
      ) : (
        <Footnote>No file stored for this generation.</Footnote>
      )}
    </TextCard>
  );
}

/** `civitai_video_fetch` / `civitai_music_fetch` / `civitai_model3d_fetch` —
 *  the stored result AND the still-running poll envelope (same kind, branch
 *  on `files`). */
export function renderCivitaiWorkflow(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || typeof d.kind !== "string") return null;
  const lane = WORKFLOW_KINDS[d.kind];
  if (!lane) return null;
  const workflowId = str(d.workflowId) ?? "";
  const files = readFiles(d.files);
  if (files.length > 0) {
    return (
      <TextCard>
        <MetricGrid items={[{ label: lane, value: `${files.length} stored`, tone: "ok" }]} />
        {workflowId && (
          <Footnote>
            workflowId <code className="bg-muted rounded px-1">{workflowId}</code>
          </Footnote>
        )}
        <FileRows files={files} />
      </TextCard>
    );
  }
  const status = str(d.status) ?? "queued";
  const queue = num(d.queuePosition);
  return (
    <TextCard>
      <MetricGrid
        items={[
          {
            label: lane,
            value: status === "processing" ? "Rendering" : "Queued",
            sub: queue != null ? `queue position ${queue}` : undefined,
          },
        ]}
      />
      {workflowId && (
        <Footnote>
          workflowId <code className="bg-muted rounded px-1">{workflowId}</code>
        </Footnote>
      )}
      <Footnote>{str(d.note) ?? "Still running — poll again."}</Footnote>
    </TextCard>
  );
}

/** `civitai_video_submit` / `civitai_music_submit` / `civitai_model3d_submit`
 *  → {kind:"civitai_*_submit", lane, workflowId, jobId, status:"submitted",
 *  note}. */
export function renderCivitaiSubmit(output: unknown): ReactNode {
  const d = parse(output);
  if (!isRecord(d) || typeof d.kind !== "string") return null;
  const lane = SUBMIT_KINDS[d.kind];
  if (!lane) return null;
  const workflowId = str(d.workflowId);
  if (!workflowId) return null;
  const jobId = str(d.jobId);
  return (
    <TextCard>
      <MetricGrid items={[{ label: lane, value: "Submitted" }]} />
      <Footnote>
        workflowId <code className="bg-muted rounded px-1">{workflowId}</code>
        {jobId ? ` · job ${jobId}` : ""}
      </Footnote>
      <Footnote>{str(d.note) ?? ""}</Footnote>
    </TextCard>
  );
}
