import type { ReactNode } from "react";

import { fmtDate, fmtNumber, isRecord, pick } from "./format";
import { KeyValueView, RecordListView } from "./atoms";
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
