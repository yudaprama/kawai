import type { ReactNode } from "react";

import { FileIcon } from "@/components/shared/file-icon";
import { emitOpenPreview } from "@/lib/preview-bridge";
import { fmtBytes, fmtDate, fmtNumber, isRecord, pick } from "./format";
import { KeyValueView, RecordListView, SectionLabel } from "./atoms";
import type { RecordItem } from "./atoms";
import { MarkdownView } from "./markdown-views";

// ── Fase 2: generic human views — one registered view per tool, no FallbackView ──

export function BrowserView({ data }: { data: Record<string, unknown> }) {
  const markdown = pick<string>(data, "markdown", "content", "text", "body");
  if (markdown) return <MarkdownView text={markdown} />;
  const url = pick<string>(data, "url", "link");
  const title = pick<string>(data, "title");
  if (url || title) {
    return (
      <KeyValueView
        entries={
          [
            ["URL", url],
            ["Judul", title],
            ["Konten", markdown ? `${markdown.slice(0, 400)}…` : null],
          ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
        }
      />
    );
  }
  return (
    <KeyValueView
      entries={Object.entries(data)
        .slice(0, 12)
        .map(([k, v]) => [k.replace(/_/g, " "), String(v ?? "—")] as [string, ReactNode])}
    />
  );
}

export function CodeGraphView({ data, raw }: { data: unknown; raw: string }) {
  if (typeof data === "string" && data.trim()) return <MarkdownView text={data} />;
  if (isRecord(data) && typeof data.result === "string") return <MarkdownView text={data.result} />;
  if (isRecord(data) && typeof data.content === "string") return <MarkdownView text={data.content} />;
  return <MarkdownView text={raw.slice(0, 4000)} />;
}

export function CalculationView({ data }: { data: Record<string, unknown> }) {
  const expr = pick<string>(data, "expression", "input", "query");
  const result = pick<string>(data, "result", "output", "value");
  const pretty = result ?? (typeof data.result === "number" ? fmtNumber(data.result) : null);
  if (expr && pretty) {
    return (
      <KeyValueView
        entries={[
          ["Ekspresi", expr],
          ["Hasil", pretty],
        ]}
      />
    );
  }
  if (pretty) return <MarkdownView text={pretty} />;
  return null;
}

export function GenericHumanView({ data, raw }: { data: unknown; raw: string }) {
  if (typeof data === "string" && data.trim()) return <MarkdownView text={data} />;
  if (isRecord(data) && typeof data.markdown === "string") return <MarkdownView text={data.markdown} />;
  if (isRecord(data) && typeof data.text === "string" && data.text.length > 40)
    return <MarkdownView text={data.text} />;
  // array of titled records → cards
  if (Array.isArray(data)) {
    const recs = data.filter(isRecord);
    if (recs.length > 0 && recs.length === data.length) {
      const items: RecordItem[] = recs.slice(0, 20).map((r, i) => {
        const title =
          ([
            "title",
            "name",
            "word",
            "symbol",
            "id",
            "place",
            "country",
            "team",
            "competition",
            "pokemon",
            "fruit",
            "meal",
            "drink",
          ]
            .map((k) => r[k])
            .find((v) => typeof v === "string") as string | undefined) ?? `Item ${i + 1}`;
        const body =
          (["description", "summary", "content", "body", "text", "synopsis", "place", "capital"]
            .map((k) => r[k])
            .find((v) => typeof v === "string") as string | undefined) ?? undefined;
        const meta =
          fmtDate(pick(r, "date", "published", "time")) ?? (typeof r.score === "number" ? `★ ${r.score}` : undefined);
        return { title, body: body?.slice(0, 200), meta };
      });
      return <RecordListView items={items} />;
    }
  }
  if (isRecord(data)) {
    // wrap object containing an array (common shape: { results: [...] } )
    const arrKey = [
      "results",
      "items",
      "data",
      "competitions",
      "teams",
      "matches",
      "groups",
      "standings",
      "pokemon",
      "fruits",
      "meals",
      "drinks",
      "books",
      "papers",
      "videos",
      "photos",
    ].find((k) => Array.isArray(data[k])) as string | undefined;
    if (arrKey && Array.isArray(data[arrKey])) {
      return <GenericHumanView data={data[arrKey]} raw={raw} />;
    }
    const entries: Array<[string, ReactNode]> = [];
    for (const [k, v] of Object.entries(data).slice(0, 20)) {
      if (v == null) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        const fmt =
          typeof v === "number"
            ? fmtNumber(v)
            : typeof v === "string" && fmtDate(v)
              ? (fmtDate(v) as string)
              : String(v);
        entries.push([k.replace(/_/g, " "), fmt]);
      } else if (Array.isArray(v)) {
        entries.push([k.replace(/_/g, " "), v.length === 0 ? "—" : `${v.length} item`]);
      }
    }
    if (entries.length > 0) return <KeyValueView entries={entries} />;
  }
  return <MarkdownView text={raw.slice(0, 3000)} />;
}

// ── office_extract_images — image gallery with OCR text ───────────────────

/** office_extract_images → { ok, summary, data: { images: [{fileId,name,bytes,locator,altText,text}], count } }.
 *  Renders a compact image list with size, alt text, and OCR preview. */
export function ImageExtractView({ data }: { data: Record<string, unknown> }) {
  const summary = pick<string>(data, "summary");
  const inner = isRecord(data.data) ? data.data : data;
  const images = Array.isArray(inner.images) ? inner.images.filter(isRecord) : [];
  if (images.length === 0 && !summary) return null;

  // count how many have OCR text
  const withText = images.filter((img) => typeof img.text === "string" && img.text.trim()).length;
  // detect cap note from summary
  const capped = typeof summary === "string" && summary.includes("capped");

  return (
    <div className="space-y-3">
      {/* summary pills */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
          🖼 {images.length} gambar diekstrak
        </span>
        {withText > 0 && (
          <span className="bg-success/10 text-success inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
            ✓ {withText} dengan teks (OCR)
          </span>
        )}
        {capped && (
          <span className="bg-warning/10 text-warning inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium">
            ⚠ dibatasi 20 gambar untuk OCR
          </span>
        )}
      </div>

      {/* image list */}
      {images.length > 0 && (
        <ul className="space-y-1.5">
          {images.slice(0, 30).map((img, i) => {
            const id = pick<string>(img, "fileId", "file_id");
            const name = pick<string>(img, "name") ?? `gambar ${i + 1}`;
            const bytes = typeof img.bytes === "number" ? img.bytes : null;
            const altText = pick<string>(img, "altText", "alt_text");
            const ocrText = pick<string>(img, "text");
            const locator = pick<string>(img, "locator");

            return (
              <li className="bg-card flex items-start gap-3 rounded-lg border px-3 py-2" key={id ?? i}>
                {id ? (
                  <button
                    className="flex shrink-0 items-center gap-2 text-left hover:underline"
                    onClick={() => emitOpenPreview(id, name)}
                    title={`Buka ${name}`}
                    type="button"
                  >
                    <FileIcon className="size-5 shrink-0" name={name} />
                  </button>
                ) : (
                  <FileIcon className="size-5 shrink-0" name={name} />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-foreground truncate text-sm font-medium" title={name}>
                      {name}
                    </span>
                    {bytes != null && (
                      <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{fmtBytes(bytes)}</span>
                    )}
                    {locator && <span className="text-muted-foreground shrink-0 font-mono text-[10px]">{locator}</span>}
                  </div>
                  {altText && (
                    <p className="text-muted-foreground mt-0.5 text-xs" title={altText}>
                      {altText.length > 80 ? `${altText.slice(0, 80)}…` : altText}
                    </p>
                  )}
                  {ocrText && (
                    <p className="text-muted-foreground mt-1 border-l-2 border-success/40 pl-2 text-xs italic">
                      {ocrText.length > 120 ? `${ocrText.slice(0, 120)}…` : ocrText}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {images.length > 30 && <SectionLabel>…dan {images.length - 30} gambar lainnya</SectionLabel>}
    </div>
  );
}
