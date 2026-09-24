import type { RagHit } from "@/generated/api-types";

function ragHits(list: unknown): RagHit[] {
  if (!Array.isArray(list)) return [];
  return list.filter((item): item is RagHit => {
    if (typeof item !== "object" || item === null) return false;
    const v = item as Record<string, unknown>;
    return typeof v.source === "string" && typeof v.locator === "string" && typeof v.content === "string";
  });
}

/** Unpack a `knowledge_search` output — the `{hits, note?}` envelope the tool
 *  emits (`crates/engines/knowledge/src/tools.rs::call`; empty searches carry
 *  retry guidance in `note`). A bare hit array is the pre-envelope shape of
 *  rows already persisted in `supervisor_step_results`. */
export function unpackKnowledgeSearch(output: unknown): { hits: RagHit[]; note: string | null } {
  if (Array.isArray(output)) return { hits: ragHits(output), note: null };
  if (typeof output !== "object" || output === null) return { hits: [], note: null };
  const envelope = output as Record<string, unknown>;
  const note = typeof envelope.note === "string" && envelope.note.trim() ? envelope.note : null;
  return { hits: ragHits(envelope.hits), note };
}

export function renderKnowledgeSearch(output: unknown) {
  const { hits, note } = unpackKnowledgeSearch(output);
  if (!hits.length && !note) return null;
  return (
    <div className="space-y-3">
      {hits.length > 0 && (
        <p className="text-muted-foreground text-xs">{hits.length} relevant source{hits.length === 1 ? "" : "s"}</p>
      )}
      {hits.map((hit, index) => (
        <article className="bg-card rounded-lg border p-3" key={`${hit.source}:${hit.locator}:${index}`}>
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="truncate text-sm font-medium" title={hit.source}>{hit.source}</span>
            <span className="text-muted-foreground shrink-0 font-mono text-[11px]">{hit.locator}</span>
          </div>
          <p className="text-muted-foreground whitespace-pre-wrap text-sm leading-relaxed">{hit.content}</p>
        </article>
      ))}
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
    </div>
  );
}
