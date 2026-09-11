import { Streamdown } from "@/lib/streamdown";
import { isRecord } from "./format";
import { SectionLabel } from "./atoms";

// ── markdown ────────────────────────────────────────────────────────────────

export function MarkdownView({ text }: { text: string }) {
  return (
    <div className="text-sm">
      <Streamdown>{text}</Streamdown>
    </div>
  );
}

/** pdf_extract_text → two wire shapes exist (the auto registry's first-wins
 *  dispatch usually serves the kawai-office wrapper, not office-tools/pdf):
 *  - `{"pages": {"1": "text", …}}` — map of page → text
 *  - `{"text": "--- page 1 ---\n…"}` — one markdown blob with page markers
 *  Both render as one collapsible panel per page. */
export function PdfPagesView({ data }: { data: Record<string, unknown> }) {
  let entries: Array<[string, string]> = [];
  if (isRecord(data.pages)) {
    entries = Object.entries(data.pages).filter(
      (pair): pair is [string, string] => typeof pair[1] === "string" && pair[1].trim().length > 0,
    );
  } else if (typeof data.text === "string") {
    // Split on the "--- page N ---" markers; content before the first marker
    // becomes page "1" when it carries text.
    const parts = data.text.split(/^---\s*page\s+(\d+)\s*---\s*$/m);
    if (parts[0]?.trim()) entries.push(["1", parts[0].trim()]);
    for (let i = 1; i + 1 < parts.length; i += 2) {
      const body = parts[i + 1]?.trim() ?? "";
      if (body) entries.push([parts[i], body]);
    }
  }
  if (entries.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{entries.length} halaman diekstrak — klik untuk membuka</SectionLabel>
      {entries.map(([page, text]) => (
        <details className="bg-card rounded-lg border p-3" key={page}>
          <summary className="text-foreground cursor-pointer text-sm font-medium">
            Halaman {page}
            <span className="text-muted-foreground ml-2 font-mono text-[11px]">
              {text.length.toLocaleString("id-ID")} karakter
            </span>
          </summary>
          <div className="mt-3 border-t pt-3">
            <MarkdownView text={text} />
          </div>
        </details>
      ))}
    </div>
  );
}
