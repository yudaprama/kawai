import { useState } from "react";
import { Streamdown } from "@/lib/streamdown";
import { useFilePreview } from "@/lib/preview-file";
import { emitOpenPreview } from "@/lib/preview-bridge";

/**
 * Chart/image token the deliverable writer may embed:
 * `![caption](kawai-file://<fileId>)`. Resolved against the office store
 * (svg renders directly; the token form matches what export_deliverable
 * rasterizes into pdf/docx).
 */
const IMAGE_TOKEN = /!\[([^\]\n]*)\]\(kawai-file:\/\/([^)\s]+)\)/g;

/** One resolved chart: store bytes inline, click opens the file preview. */
function ChartFigure({ fileId, alt }: { fileId: string; alt: string }) {
  const name = alt ? `${alt}.svg` : `chart-${fileId}.svg`;
  const { data, isLoading, error } = useFilePreview({ id: fileId, name });
  const [errored, setErrored] = useState(false);
  // Loading and unresolvable states stay silent — a missing chart must not
  // render as a broken block inside the deliverable.
  if (isLoading || error || errored || !data?.dataUrl) return null;
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
