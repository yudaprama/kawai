import type { ReactNode } from "react";

import { renderKnowledgeSearch } from "@/components/ai-elements/tool-renderers/knowledge";

import { isRecord, parseMaybeJson } from "./format";
import { FallbackView } from "./fallback";
import {
  FileListView,
  FinancialTableView,
  KeyValueView,
  MarkdownView,
  MemoryGraphView,
  MemoryLinesView,
  NewsListView,
  PdfPagesView,
  SocialFeedView,
  SparklineView,
  StockQuoteView,
  TrendingView,
} from "./views";

// ── registry ────────────────────────────────────────────────────────────────

type StepView = (parsed: unknown, raw: string) => ReactNode;

/** Map tool name → human view. Categories serve many tools; anything
 *  unregistered falls through to the heuristic FallbackView. */
const registry: Record<string, StepView> = {
  // markdown documents
  office_read_document: (p) =>
    isRecord(p) && typeof p.markdown === "string" ? <MarkdownView text={p.markdown} /> : null,
  office_create_document: (p) =>
    isRecord(p) && typeof p.markdown === "string" ? <MarkdownView text={p.markdown} /> : null,
  pdf_create_from_markdown: (p) => (isRecord(p) ? genericKv(p) : null),

  // pdf
  pdf_extract_text: (p) => (isRecord(p) ? <PdfPagesView data={p} /> : null),
  pdf_search_text: (p) =>
    isRecord(p)
      ? genericKv({
          pattern: p.pattern,
          jumlah_hasil: Array.isArray(p.matches) ? p.matches.length : undefined,
          matches: p.matches,
        })
      : null,
  pdf_info: (p) => (isRecord(p) ? genericKv(isRecord(p.metadata) ? p.metadata : p) : null),
  pdf_metadata_get: (p) => (isRecord(p) ? genericKv(isRecord(p.metadata) ? p.metadata : p) : null),
  pdf_page_info: (p) => (isRecord(p) ? genericKv(p) : null),

  // office files
  office_list_files: (p) => (isRecord(p) ? <FileListView data={p} /> : null),
  office_document_info: (p) => (isRecord(p) ? genericKv(p) : null),

  // memory
  memory_search: (_, raw) => <MemoryLinesView text={raw} />,
  memory_graph_search: (_, raw) => <MemoryGraphView text={raw} />,

  // knowledge — reuse the vendored renderer (same RagHit shape)
  knowledge_search: (p) => renderKnowledgeSearch(p),

  // finance — quotes & history
  get_stock_price: (p) => (isRecord(p) ? <StockQuoteView data={p} /> : null),
  get_stock_quote: (p) => (isRecord(p) ? <StockQuoteView data={p} /> : null),
  get_stock_detail: (p) => (isRecord(p) ? <StockQuoteView data={p} /> : null),
  get_stock_history: (p) => {
    if (!isRecord(p)) return null;
    const values = Array.isArray(p.values) ? p.values.filter(isRecord) : [];
    const closes = values.map((v) => Number(v.close)).filter((n) => Number.isFinite(n));
    return closes.length >= 2 ? (
      <SparklineView closes={closes} label={`${p.symbol ?? ""} · harga penutupan harian`} />
    ) : null;
  },
  trending_stocks: (p) => (isRecord(p) ? <TrendingView data={p} /> : null),
  stock_social_feed: (p) => <SocialFeedView data={p} />,
  get_stock_news: (p) => <NewsListView data={p} />,
  get_global_news: (p) => <NewsListView data={p} />,
  get_reddit_posts: (p) => <NewsListView data={p} />,

  // finance — statements
  get_balance_sheet: (p) => (isRecord(p) ? <FinancialTableView data={p} /> : null),
  get_income_statement: (p) => (isRecord(p) ? <FinancialTableView data={p} /> : null),
  get_cashflow: (p) => (isRecord(p) ? <FinancialTableView data={p} /> : null),
};

function genericKv(o: Record<string, unknown>): ReactNode {
  const entries: Array<[string, ReactNode]> = [];
  for (const [k, v] of Object.entries(o)) {
    if (v == null) continue;
    const label = k.replace(/_/g, " ");
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      entries.push([label, String(v)]);
    } else if (Array.isArray(v)) {
      entries.push([
        label,
        v.length === 0 ? (
          "—"
        ) : (
          <code className="font-mono text-xs" key={label}>
            {JSON.stringify(v).slice(0, 300)}
          </code>
        ),
      ]);
    } else if (isRecord(v)) {
      entries.push([
        label,
        <code className="font-mono text-xs" key={label}>
          {JSON.stringify(v).slice(0, 300)}
        </code>,
      ]);
    }
  }
  return entries.length > 0 ? <KeyValueView entries={entries} /> : null;
}

// ── public API ──────────────────────────────────────────────────────────────

/** Render a supervisor step's ≤2000-char output preview for humans. Always
 *  returns something readable — dedicated view → heuristic fallback. */
export function renderStepReport(tool: string, output: string): ReactNode {
  const parsed = parseMaybeJson(output);
  const fn = registry[tool];
  if (fn) {
    try {
      const view = fn(parsed, output);
      if (view != null) return view;
    } catch {
      // fall through to the heuristic view
    }
  }
  return <FallbackView output={output} />;
}
