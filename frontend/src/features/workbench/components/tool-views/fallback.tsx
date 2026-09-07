import { isRecord, parseMaybeJson } from "./format";
import { KeyValueView, MarkdownView, RecordListView, type RecordItem } from "./views";

/** Field names that read as human titles in generic record arrays. */
const TITLE_KEYS = ["title", "name", "originalName", "original_name", "symbol", "id", "entity", "locator"];
const BODY_KEYS = ["content", "body", "text", "summary", "description", "markdown"];

/** Heuristic human-readable rendering for tools without a dedicated view.
 *  Order: markdown-ish text → generic JSON shapes → plain text. */
export function FallbackView({ output }: { output: string }) {
  const parsed = parseMaybeJson(output);

  // Generic JSON array of records → titled cards / key-value grid.
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return <EmptyView />;
    const records = parsed.filter(isRecord);
    if (records.length === parsed.length && records.length > 0) {
      const titleish = TITLE_KEYS.some((k) => records.some((r) => typeof r[k] === "string"));
      if (titleish) {
        const items: RecordItem[] = records.map((r, i) => {
          const title = TITLE_KEYS.map((k) => r[k]).find((v) => typeof v === "string") as string | undefined;
          const body = BODY_KEYS.map((k) => r[k]).find((v) => typeof v === "string") as string | undefined;
          const extra = Object.entries(r)
            .filter(
              ([k, v]) =>
                !TITLE_KEYS.includes(k) && !BODY_KEYS.includes(k) && (typeof v === "string" || typeof v === "number"),
            )
            .slice(0, 3)
            .map(([k, v]) => `${k}: ${v}`)
            .join(" · ");
          return { title: title ?? `Item ${i + 1}`, body: [body, extra].filter(Boolean).join("\n") || undefined };
        });
        return <RecordListView items={items} />;
      }
    }
    // Scalars → bullet list.
    return (
      <ul className="list-disc space-y-1 pl-5 text-sm">
        {parsed.slice(0, 30).map((v, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
          <li key={JSON.stringify(v).slice(0, 40) + i}>{typeof v === "string" ? v : JSON.stringify(v)}</li>
        ))}
      </ul>
    );
  }

  if (isRecord(parsed)) {
    // Single markdown field → document view (office_read_document etc.).
    const md = parsed.markdown ?? parsed.content ?? parsed.text;
    if (typeof md === "string" && md.trim()) return <MarkdownView text={md} />;
    const entries: Array<[string, React.ReactNode]> = [];
    for (const [k, v] of Object.entries(parsed)) {
      if (v == null) continue;
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        entries.push([k, String(v)]);
      } else {
        entries.push([
          k,
          <code className="font-mono text-xs" key={k}>
            {JSON.stringify(v).slice(0, 200)}
          </code>,
        ]);
      }
    }
    if (entries.length > 0) return <KeyValueView entries={entries} />;
    return <MarkdownView text={output} />;
  }

  // Plain text: markdown if it has structure, otherwise paragraphs.
  const text = output.trim();
  if (!text) return <EmptyView />;
  if (/^#{1,3}\s|\n#{1,3}\s|\n[-*]\s|\n\d+\.\s/.test(text)) return <MarkdownView text={text} />;
  return <MarkdownView text={text} />;
}

export function EmptyView() {
  return <p className="text-muted-foreground text-sm">Tidak ada hasil yang dikembalikan.</p>;
}
