import { useState } from "react";
import { Streamdown } from "@/lib/streamdown";
import { useFilePreview } from "@/lib/preview-file";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { linkifyTimestamps, youtubeSeekSeconds } from "./youtube-embed";

/**
 * Media token the deliverable writer may embed:
 * `![caption](kawai-file://<fileId>)`. Resolved against the office store —
 * images render inline (svg chart figures), `video/*` files render as a
 * native `<video>` player, `audio/*` files as a native `<audio>` player;
 * the token form matches what export_deliverable
 * rasterizes into pdf/docx (videos stay viewer-only there).
 */
const IMAGE_TOKEN = /!\[([^\]\n]*)\]\(kawai-file:\/\/([^)\s]+)\)/g;

/** One resolved chart: store bytes inline, click opens the file preview.
 *  Missing/unresolvable charts render an explicit placeholder — never a
 *  silent hole in the deliverable. */
function ChartFigure({ fileId, alt }: { fileId: string; alt: string }) {
  const name = alt ? `${alt}.svg` : `chart-${fileId}.svg`;
  const { data, isLoading, error } = useFilePreview({ id: fileId, name });
  const [errored, setErrored] = useState(false);
  if (isLoading) {
    return (
      <div
        aria-busy="true"
        className="bg-muted/50 h-48 w-full animate-pulse rounded-md border border-dashed"
        role="status"
      />
    );
  }
  if (error || errored || !data?.dataUrl) {
    return (
      <div className="text-muted-foreground flex h-24 w-full items-center justify-center rounded-md border border-dashed text-xs">
        {alt ? `${alt} — media unavailable` : "Media unavailable"}
      </div>
    );
  }
  // Video files (e.g. a Generator clip referenced by id) play inline.
  if (data.mime.startsWith("video/")) {
    return (
      <figure className="overflow-hidden rounded-md border">
        <video className="aspect-video w-full bg-black object-contain" controls playsInline src={data.dataUrl}>
          <track kind="captions" />
        </video>
        {alt && <figcaption className="text-muted-foreground p-2 text-xs">{alt}</figcaption>}
      </figure>
    );
  }
  // Audio files (e.g. a Generator track referenced by id) play inline.
  if (data.mime.startsWith("audio/")) {
    return (
      <figure className="overflow-hidden rounded-md border p-2">
        <audio className="w-full" controls src={data.dataUrl}>
          <track kind="captions" />
        </audio>
        {alt && <figcaption className="text-muted-foreground pt-1 text-xs">{alt}</figcaption>}
      </figure>
    );
  }
  return (
    <button
      className="bg-card block w-full cursor-zoom-in rounded-md border p-2"
      onClick={() => emitOpenPreview(fileId, name)}
      title={alt || "Open chart"}
      type="button"
    >
      <img
        alt={alt}
        className="mx-auto max-h-96 w-auto max-w-full object-contain"
        onError={() => setErrored(true)}
        src={data.dataUrl}
      />
    </button>
  );
}

/**
 * Deliverable markdown with inline chart support: text renders through
 * Streamdown exactly as before; `kawai-file://` image tokens render as
 * store-backed chart figures between the text segments.
 *
 * On a YouTube run (`videoId` set), the timestamp links `linkifyTimestamps`
 * produced are intercepted at the container and turned into player seeks —
 * the href stays a real watch URL, so a swallowed click still degrades to
 * opening the video.
 */
export function MarkdownWithCharts({
  children,
  videoId,
  onSeek,
}: {
  children: string;
  /** Source video of a YouTube Summary run — enables timestamp-link seeks. */
  videoId?: string | null;
  /** The player's seek — wired by the same parent that owns the embed. */
  onSeek?: (seconds: number) => void;
}) {
  // Click capture: a timestamp anchor becomes a seek; everything else
  // (including other youtube links of other videos) navigates normally.
  const onClickCapture = (e: React.MouseEvent<HTMLDivElement>) => {
    if (videoId == null || onSeek == null) return;
    const anchor = (e.target as HTMLElement | null)?.closest("a");
    if (anchor == null) return;
    const seconds = youtubeSeekSeconds(anchor.getAttribute("href") ?? "", videoId);
    if (seconds == null) return;
    e.preventDefault();
    onSeek(seconds);
  };

  const body = videoId != null ? linkifyTimestamps(children, videoId) : children;
  return (
    <div onClickCapture={videoId != null && onSeek != null ? onClickCapture : undefined}>
      <Body segments={segmentChartTokens(body)} />
    </div>
  );
}

/** Split the markdown into text runs and `kawai-file://` chart tokens —
 *  text renders as Streamdown, tokens as figures between the segments. Each
 *  segment carries its source offset so React keys are stable positions,
 *  never array indices. */
type MarkdownSegment = { at: number; text: string; chart: { fileId: string; alt: string } | null };

function segmentChartTokens(markdown: string): MarkdownSegment[] {
  const segments: MarkdownSegment[] = [];
  let last = 0;
  for (const m of markdown.matchAll(IMAGE_TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) segments.push({ at: last, text: markdown.slice(last, idx), chart: null });
    segments.push({ at: idx, text: "", chart: { fileId: m[2] ?? "", alt: m[1] ?? "" } });
    last = idx + m[0].length;
  }
  if (segments.length === 0) return [{ at: 0, text: markdown, chart: null }];
  if (last < markdown.length) segments.push({ at: last, text: markdown.slice(last), chart: null });
  return segments;
}

function Body({ segments }: { segments: MarkdownSegment[] }) {
  return (
    <div className="space-y-3">
      {segments.map((s) =>
        s.chart != null ? (
          <ChartFigure key={`c${s.at}`} fileId={s.chart.fileId} alt={s.chart.alt} />
        ) : (
          <Streamdown key={`t${s.at}`}>{s.text}</Streamdown>
        ),
      )}
    </div>
  );
}
