import { useState } from "react";
import { Streamdown } from "@/lib/streamdown";
import { useFilePreview } from "@/lib/preview-file";
import { emitOpenPreview } from "@/lib/preview-bridge";

/**
 * Media token the deliverable writer may embed:
 * `![caption](kawai-file://<fileId>)`. Resolved against the office store —
 * images render inline (svg chart figures), `video/*` files render as a
 * native `<video>` player; the token form matches what export_deliverable
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
 */
export function MarkdownWithCharts({ children }: { children: string }) {
  const parts: React.ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of children.matchAll(IMAGE_TOKEN)) {
    const idx = m.index ?? 0;
    if (idx > last) {
      parts.push(<Streamdown key={`t${last}`}>{children.slice(last, idx)}</Streamdown>);
    }
    const fileId = m[2] ?? "";
    parts.push(<ChartFigure key={`c${i++}`} fileId={fileId} alt={m[1] ?? ""} />);
    last = idx + m[0].length;
  }
  if (parts.length === 0) return <Streamdown>{children}</Streamdown>;
  if (last < children.length) {
    parts.push(<Streamdown key={`t${last}`}>{children.slice(last)}</Streamdown>);
  }
  return <div className="space-y-3">{parts}</div>;
}
