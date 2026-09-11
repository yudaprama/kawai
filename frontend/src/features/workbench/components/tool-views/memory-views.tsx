import { fmtDate, isRecord } from "./format";
import { Pill, RecordListView, SectionLabel } from "./atoms";
import type { RecordItem } from "./atoms";
import { MarkdownView } from "./markdown-views";

// ── session history ─────────────────────────────────────────────────────────

interface SessionStepEntry {
  run?: unknown;
  is_last_run?: unknown;
  tool?: unknown;
  finished_at?: unknown;
  output?: unknown;
  truncated?: unknown;
}

/** session_step_results → one card per earlier-run step output, newest
 *  first. The output is the previous run's own text (often the synthesized
 *  deliverable) — rendered as markdown; the truncated note points at the
 *  full body via the report switcher. */
export function SessionStepResultsView({ data }: { data: Record<string, unknown> }) {
  const entries = (Array.isArray(data.entries) ? data.entries : []).filter(isRecord) as SessionStepEntry[];
  if (entries.length === 0) {
    const note = typeof data.note === "string" ? data.note : null;
    return note ? <SectionLabel>{note}</SectionLabel> : null;
  }
  return (
    <div className="space-y-3">
      {entries.map((e, i) => {
        const tool = typeof e.tool === "string" ? e.tool : "step";
        const output = typeof e.output === "string" ? e.output : "";
        const finished = fmtDate(e.finished_at);
        const truncated = e.truncated === true;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: session step entries lack stable ids; run may duplicate
          <div className="bg-background/50 border-border/60 rounded-lg border p-3" key={`${e.run ?? "run"}-${i}`}>
            <div className="text-muted-foreground mb-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="text-foreground/80 font-semibold">
                {tool === "deliverable_writer" ? "Deliverable" : tool}
              </span>
              {e.is_last_run === true && <Pill>last run</Pill>}
              {finished && <span>{finished}</span>}
              {truncated && <span className="text-warning">truncated — full body via the report switcher</span>}
            </div>
            {output ? <MarkdownView text={output} /> : <SectionLabel>(no output)</SectionLabel>}
          </div>
        );
      })}
    </div>
  );
}

// ── record-list (memories, generic titled entities) ─────────────────────────

const MEMORY_LINE = /^-\s*\((\w+)\s*\|\s*([\w-]+)\)\s*(.+?):\s*(.*)$/;

/** memory_search → "- (fact | mem_xxx) Judul: isi…" per baris. */
export function MemoryLinesView({ text }: { text: string }) {
  const items: RecordItem[] = [];
  for (const line of text.split("\n")) {
    const m = MEMORY_LINE.exec(line.trim());
    if (m) {
      items.push({ badge: m[1], title: m[3], body: m[4], meta: m[2] });
    }
  }
  if (items.length === 0) return null;
  return <RecordListView items={items} />;
}

/** memory_graph_search → "## Entitas" sections of memory lines. */
export function MemoryGraphView({ text }: { text: string }) {
  const sections = text.split(/^##\s+/m).filter((s) => s.trim());
  if (sections.length === 0) return null;
  return (
    <div className="space-y-4">
      {sections.map((sec, i) => {
        const [head, ...rest] = sec.split("\n");
        const entity = head.trim();
        const items: RecordItem[] = [];
        for (const line of rest) {
          const m = MEMORY_LINE.exec(line.trim());
          if (m) items.push({ badge: m[1], title: m[3], body: m[4], meta: m[2] });
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
          <div key={i}>
            <h4 className="text-foreground mb-1.5 text-sm font-semibold">{entity}</h4>
            {items.length > 0 ? <RecordListView items={items} /> : null}
          </div>
        );
      })}
    </div>
  );
}
