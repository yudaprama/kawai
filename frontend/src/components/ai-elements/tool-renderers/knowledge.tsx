import type { RagHit } from "@/generated/api-types";

function hits(value: unknown): RagHit[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is RagHit => {
    if (typeof item !== "object" || item === null) return false;
    const v = item as Record<string, unknown>;
    return typeof v.source === "string" && typeof v.locator === "string" && typeof v.content === "string";
  });
}

export function renderKnowledgeSearch(output: unknown) {
  const results = hits(output);
  if (!results.length) return null;
  return (
    <div className="space-y-3">
      <p className="text-muted-foreground text-xs">{results.length} relevant source{results.length === 1 ? "" : "s"}</p>
      {results.map((hit, index) => (
        <article className="bg-card rounded-lg border p-3" key={`${hit.source}:${hit.locator}:${index}`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="truncate text-sm font-medium" title={hit.source}>{hit.source}</span>
            <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{hit.locator}</span>
          </div>
          <p className="text-muted-foreground whitespace-pre-wrap text-sm leading-relaxed">{hit.content}</p>
        </article>
      ))}
    </div>
  );
}
