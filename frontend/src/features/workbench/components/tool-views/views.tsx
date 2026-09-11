import type { ReactNode } from "react";

import { Streamdown } from "@/lib/streamdown";

import { fmtBytes, fmtDate, fmtNumber, fmtPct, isRecord, pick, toNum } from "./format";

// ── Shared atoms ────────────────────────────────────────────────────────────

export function SectionLabel({ children }: { children: ReactNode }) {
  return <p className="text-muted-foreground text-xs">{children}</p>;
}

/** Two-column "label → value" table for flat facts. */
export function KeyValueView({ entries }: { entries: Array<[string, ReactNode]> }) {
  const rows = entries.filter(([, v]) => v != null && v !== "");
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map(([k, v]) => (
        <div className="contents" key={k}>
          <dt className="text-muted-foreground py-0.5">{k}</dt>
          <dd className="text-foreground break-words py-0.5">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** [label, formatted number | null] helper for KeyValueView. */
function kvNum(label: string, v: unknown, opts?: Intl.NumberFormatOptions): [string, ReactNode] {
  const n = toNum(v);
  return [label, n != null ? fmtNumber(n, opts) : null];
}

const Pill = ({ children, tone = "neutral" }: { children: ReactNode; tone?: "up" | "down" | "neutral" }) => (
  <span
    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
      tone === "up"
        ? "bg-success/15 text-success"
        : tone === "down"
          ? "bg-destructive/15 text-destructive"
          : "bg-muted text-muted-foreground"
    }`}
  >
    {children}
  </span>
);

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

// ── file-list ───────────────────────────────────────────────────────────────

const EXT_TONE: Record<string, string> = {
  pdf: "bg-destructive/15 text-destructive",
  docx: "bg-primary/15 text-primary",
  xlsx: "bg-success/15 text-success",
  pptx: "bg-warning/15 text-warning",
};

/** office_list_files → {"files": [{id, originalName, ext, bytes, createdAt}]} */
export function FileListView({ data }: { data: Record<string, unknown> }) {
  const files = Array.isArray(data.files) ? data.files.filter(isRecord) : [];
  if (files.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{files.length} dokumen ditemukan</SectionLabel>
      <ul className="space-y-1.5">
        {files.slice(0, 30).map((f, i) => {
          const name = pick<string>(f, "originalName", "original_name", "name") ?? "Tanpa nama";
          const ext = (pick<string>(f, "ext", "extension") ?? "").toLowerCase();
          const bytes = toNum(pick(f, "bytes", "size"));
          const created = fmtDate(pick(f, "createdAt", "created_at"));
          const id = pick<string>(f, "id");
          return (
            <li className="bg-card flex items-center gap-3 rounded-lg border px-3 py-2" key={id ?? i}>
              <span
                className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${EXT_TONE[ext] ?? "bg-muted text-muted-foreground"}`}
              >
                {ext || "file"}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-foreground truncate text-sm" title={name}>
                  {name}
                </div>
                <div className="text-muted-foreground truncate font-mono text-[11px]" title={id}>
                  {id}
                </div>
              </div>
              <div className="text-muted-foreground shrink-0 text-right font-mono text-[11px]">
                {bytes != null && <div>{fmtBytes(bytes)}</div>}
                {created && <div>{created}</div>}
              </div>
            </li>
          );
        })}
      </ul>
      {files.length > 30 && <SectionLabel>…dan {files.length - 30} dokumen lainnya</SectionLabel>}
    </div>
  );
}

// ── file-created (pdf_create_from_markdown and friends) ────────────────────

/** A tool result that created one stored file → single file card with
 *  human metadata (name / size / created) instead of raw JSON. */
export function FileCreatedView({ data }: { data: Record<string, unknown> }) {
  const file = isRecord(data.file) ? data.file : data;
  const id = pick<string>(file, "id", "fileId");
  const name = pick<string>(file, "originalName", "original_name", "filename", "name");
  if (!id && !name) return null;
  const ext = (pick<string>(file, "ext", "extension") ?? "").toLowerCase();
  const bytes = toNum(pick(file, "bytes", "size"));
  const created = fmtDate(pick(file, "createdAt", "created_at"));
  return (
    <div className="bg-card flex items-center gap-3 rounded-lg border px-3 py-2">
      <span
        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase ${EXT_TONE[ext] ?? "bg-muted text-muted-foreground"}`}
      >
        {ext || "file"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-foreground truncate text-sm" title={name ?? id}>
          {name ?? id}
        </div>
        <div className="text-muted-foreground text-xs">Dokumen berhasil dibuat</div>
      </div>
      <div className="text-muted-foreground shrink-0 text-right font-mono text-[11px]">
        {bytes != null && <div>{fmtBytes(bytes)}</div>}
        {created && <div>{created}</div>}
      </div>
    </div>
  );
}

// ── record-list (memories, generic titled entities) ─────────────────────────

export interface RecordItem {
  title: string;
  badge?: string;
  meta?: string;
  body?: string;
}

/** Titled cards with an optional body — memory items, search hits, posts. */
export function RecordListView({ items }: { items: RecordItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{items.length} hasil ditemukan</SectionLabel>
      <ul className="space-y-2">
        {items.slice(0, 20).map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
          <li className="bg-card rounded-lg border p-3" key={`${it.title}:${i}`}>
            <div className="flex items-center gap-2">
              {it.badge && <Pill>{it.badge}</Pill>}
              <span className="text-foreground min-w-0 truncate text-sm font-medium" title={it.title}>
                {it.title}
              </span>
              {it.meta && (
                <span className="text-muted-foreground ml-auto shrink-0 font-mono text-[10px]">{it.meta}</span>
              )}
            </div>
            {it.body && <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{it.body}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

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

// ── stock-quote ─────────────────────────────────────────────────────────────

/** Inline SVG sparkline for a close-price series (get_stock_history). */
export function SparklineView({ closes, label }: { closes: number[]; label: string }) {
  if (closes.length < 2) return null;
  const w = 560;
  const h = 120;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const pts = closes
    .map((c, i) => `${(i / (closes.length - 1)) * w},${h - ((c - min) / span) * (h - 12) - 6}`)
    .join(" ");
  const up = closes[closes.length - 1] >= closes[0];
  const stroke = up ? "text-success" : "text-destructive";
  const delta = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-3">
        <span className="text-muted-foreground text-xs">{label}</span>
        <Pill tone={up ? "up" : "down"}>
          {up ? "▲" : "▼"} {fmtPct(Math.abs(delta))} selama periode ini
        </Pill>
      </div>
      <svg
        className={`${stroke} w-full`}
        preserveAspectRatio="none"
        role="img"
        viewBox={`0 0 ${w} ${h}`}
        aria-label="Grafik harga"
      >
        <title>Grafik harga</title>
        <polyline fill="none" points={pts} stroke="currentColor" strokeWidth="2" />
      </svg>
      <div className="text-muted-foreground flex justify-between font-mono text-[11px]">
        <span>terendah {fmtNumber(min)}</span>
        <span>tertinggi {fmtNumber(max)}</span>
      </div>
    </div>
  );
}

/** get_stock_price / get_stock_quote / get_stock_detail — big number + delta. */
export function StockQuoteView({ data }: { data: Record<string, unknown> }) {
  const price = toNum(pick(data, "price", "close", "regularMarketPrice"));
  const symbol = pick<string>(data, "symbol", "ticker") ?? "";
  const name = pick<string>(data, "name", "instrument_name", "shortName");
  if (price == null && !symbol) return null;
  const change = toNum(pick(data, "change"));
  const pct = toNum(pick(data, "percent_change", "changesPercentage"));
  const up = (change ?? pct ?? 0) >= 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-foreground font-mono text-sm font-bold">{symbol}</span>
        {name && <span className="text-muted-foreground text-sm">{name}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {price != null && (
          <span className="text-foreground text-4xl font-semibold tabular-nums">{fmtNumber(price)}</span>
        )}
        {pct != null && (
          <Pill tone={up ? "up" : "down"}>
            {up ? "▲ Naik" : "▼ Turun"} {fmtPct(Math.abs(pct))}
          </Pill>
        )}
        {change != null && (
          <span className={`text-sm font-medium ${up ? "text-success" : "text-destructive"}`}>
            {up ? "+" : "−"}
            {fmtNumber(Math.abs(change))}
          </span>
        )}
      </div>
      <KeyValueView
        entries={[
          (() => {
            const prev = toNum(data.previous_close);
            return ["Penutupan sebelumnya", prev != null ? fmtNumber(prev) : null] as [string, ReactNode];
          })(),
          kvNum("Harga pembukaan", pick(data, "open")),
          kvNum("Tertinggi hari ini", pick(data, "day_high", "high")),
          kvNum("Terendah hari ini", pick(data, "day_low", "low")),
          kvNum("Volume", pick(data, "volume"), { notation: "compact" }),
          kvNum("Kapitalisasi pasar", pick(data, "market_cap", "marketCap"), { notation: "compact" }),
          [
            "Rentang 52 minggu",
            (() => {
              const lo = toNum(pick(data, "fifty_two_week_low", "fiftyTwoWeekLow"));
              const hi = toNum(pick(data, "fifty_two_week_high", "fiftyTwoWeekHigh"));
              return lo != null && hi != null ? `${fmtNumber(lo)} – ${fmtNumber(hi)}` : null;
            })(),
          ],
        ]}
      />
    </div>
  );
}

// ── financial-table ─────────────────────────────────────────────────────────

const PERIOD_KEYS = ["date", "endDate", "end_date", "asOfDate", "period", "fiscalDateEnding"];

/** get_balance_sheet / get_income_statement / get_cashflow → one table of
 *  periods × line items. */
export function FinancialTableView({ data }: { data: Record<string, unknown> }) {
  const statements = Array.isArray(data.statements) ? data.statements.filter(isRecord) : [];
  if (statements.length === 0) return null;
  const freq = pick<string>(data, "freq") === "annual" ? "tahunan" : "kuartalan";
  const columns = statements.map((s, i) => {
    const dateVal = PERIOD_KEYS.map((k) => pick<string>(s, k)).find(Boolean);
    return dateVal ?? `Periode ${i + 1}`;
  });
  const rows = new Set<string>();
  for (const s of statements) for (const k of Object.keys(s)) if (!PERIOD_KEYS.includes(k)) rows.add(k);
  const fmtCell = (v: unknown): string => {
    const n = toNum(v);
    return n != null ? fmtNumber(n, { notation: Math.abs(n) >= 10000 ? "compact" : "standard" }) : String(v ?? "—");
  };
  return (
    <div className="space-y-2">
      <SectionLabel>
        Laporan keuangan {pick<string>(data, "ticker", "symbol") ?? ""} · data {freq} · {statements.length} periode
      </SectionLabel>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/50 border-b">
              <th className="text-muted-foreground px-3 py-2 text-left font-medium">Pos</th>
              {columns.map((c) => (
                <th className="text-muted-foreground px-3 py-2 text-right font-medium" key={c}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...rows].map((k) => (
              <tr className="border-border/50 border-b last:border-b-0" key={k}>
                <td className="text-foreground px-3 py-1.5">{k}</td>
                {statements.map((s, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
                  <td className="text-foreground px-3 py-1.5 text-right tabular-nums" key={i}>
                    {fmtCell(s[k])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── news-list ───────────────────────────────────────────────────────────────

interface NewsItem {
  title: string;
  source?: string;
  date?: string | null;
  summary?: string;
  link?: string;
}

function newsItems(data: unknown): NewsItem[] {
  const arr = isRecord(data)
    ? (pick<unknown[]>(data, "articles", "news", "posts", "result") ?? [])
    : Array.isArray(data)
      ? data
      : [];
  const out: NewsItem[] = [];
  for (const raw of arr) {
    if (typeof raw === "string") {
      out.push({ title: raw });
      continue;
    }
    if (!isRecord(raw)) continue;
    const title = pick<string>(raw, "title", "headline", "name");
    if (!title) continue;
    out.push({
      title,
      source: pick<string>(raw, "publisher", "source", "author", "user", "site"),
      date: fmtDate(pick(raw, "published", "publishedAt", "published_at", "created_at", "date", "datetime")),
      summary: pick<string>(raw, "summary", "description", "body", "text", "snippet"),
      link: pick<string>(raw, "link", "url"),
    });
  }
  return out;
}

/** get_stock_news / get_global_news / get_reddit_posts — headline cards. */
export function NewsListView({ data }: { data: unknown }) {
  const items = newsItems(data);
  if (items.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{items.length} berita / pos ditemukan</SectionLabel>
      <ul className="space-y-2">
        {items.slice(0, 15).map((it, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
          <li className="bg-card rounded-lg border p-3" key={`${it.title}:${i}`}>
            <div className="flex items-baseline gap-2">
              {it.link ? (
                <a
                  className="text-foreground text-sm font-medium hover:underline"
                  href={it.link}
                  rel="noreferrer"
                  target="_blank"
                >
                  {it.title}
                </a>
              ) : (
                <span className="text-foreground text-sm font-medium">{it.title}</span>
              )}
            </div>
            {(it.source || it.date) && (
              <div className="text-muted-foreground mt-1 font-mono text-[11px]">
                {[it.source, it.date].filter(Boolean).join(" · ")}
              </div>
            )}
            {it.summary && <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{it.summary}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── social ──────────────────────────────────────────────────────────────────

/** trending_stocks → {"trending": [{symbol, title, watchers}]} */
export function TrendingView({ data }: { data: Record<string, unknown> }) {
  const trending = Array.isArray(data.trending) ? data.trending.filter(isRecord) : [];
  if (trending.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{trending.length} saham sedang tren</SectionLabel>
      <ol className="space-y-1.5">
        {trending.slice(0, 15).map((t, i) => {
          const watchers = toNum(pick(t, "watchers", "watchlist_count"));
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
            <li className="bg-card flex items-center gap-3 rounded-lg border px-3 py-2" key={i}>
              <span className="text-muted-foreground w-5 shrink-0 text-right font-mono text-xs">{i + 1}.</span>
              <span className="text-foreground font-mono text-sm font-bold">{pick<string>(t, "symbol") ?? "—"}</span>
              <span className="text-muted-foreground min-w-0 flex-1 truncate text-sm">{pick<string>(t, "title")}</span>
              {watchers != null && (
                <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
                  {fmtNumber(watchers)} pengamat
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const SENTIMENT_TONE: Record<string, "up" | "down" | "neutral"> = {
  bullish: "up",
  bearish: "down",
};

/** stock_social_feed → {"messages": [{user, body, sentiment, created_at, likes}]} */
export function SocialFeedView({ data }: { data: unknown }) {
  const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages.filter(isRecord) : [];
  if (messages.length === 0) return null;
  const symbol = isRecord(data) ? pick<string>(data, "symbol") : undefined;
  const counts = { bullish: 0, bearish: 0, neutral: 0 };
  for (const m of messages) {
    const s = (pick<string>(m, "sentiment") ?? "neutral").toLowerCase();
    if (s in counts) counts[s as keyof typeof counts]++;
  }
  return (
    <div className="space-y-2">
      <SectionLabel>
        {symbol && <span className="font-mono">{symbol} · </span>}
        {messages.length} pos trader — {counts.bullish} bullish, {counts.bearish} bearish, {counts.neutral} netral
      </SectionLabel>
      <ul className="space-y-2">
        {messages.slice(0, 15).map((m, i) => {
          const sentiment = (pick<string>(m, "sentiment") ?? "neutral").toLowerCase();
          const body = pick<string>(m, "body", "text");
          const user = pick<string>(m, "user", "username");
          const date = fmtDate(pick(m, "created_at", "createdAt"));
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: tool outputs may legitimately contain duplicate entries
            <li className="bg-card rounded-lg border p-3" key={i}>
              <div className="flex flex-wrap items-center gap-2">
                <Pill tone={SENTIMENT_TONE[sentiment] ?? "neutral"}>{sentiment}</Pill>
                <span className="text-foreground font-mono text-xs font-medium">{user ?? "anonim"}</span>
                {date && <span className="text-muted-foreground ml-auto font-mono text-[10px]">{date}</span>}
              </div>
              {body && <p className="text-muted-foreground mt-1.5 text-sm leading-relaxed">{body}</p>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

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

// ── Bespoke top-10 (Fase 2 polish) ──────────────────────────────────────────

export function PokemonView({ data }: { data: Record<string, unknown> }) {
  const name = pick<string>(data, "name") ?? "Unknown";
  const id = toNum(pick(data, "id"));
  const height = toNum(pick(data, "height"));
  const weight = toNum(pick(data, "weight"));
  const sprite =
    (isRecord(data.sprites) && typeof data.sprites.front_default === "string" ? data.sprites.front_default : null) ??
    (isRecord(data.sprites) &&
    isRecord(data.sprites.other) &&
    isRecord((data.sprites.other as Record<string, unknown>)["official-artwork"])
      ? (((data.sprites.other as Record<string, unknown>)["official-artwork"] as Record<string, unknown>)
          .front_default as string | undefined)
      : undefined);
  const types = Array.isArray(data.types)
    ? data.types
        .map((t) => (isRecord(t) && isRecord(t.type) ? pick<string>(t.type as Record<string, unknown>, "name") : null))
        .filter(Boolean)
        .join(" · ")
    : null;
  const abilities = Array.isArray(data.abilities)
    ? data.abilities
        .map((a) =>
          isRecord(a) && isRecord(a.ability) ? pick<string>(a.ability as Record<string, unknown>, "name") : null,
        )
        .filter(Boolean)
        .slice(0, 4)
        .join(", ")
    : null;
  const stats = Array.isArray(data.stats)
    ? data.stats
        .map((s) => {
          if (!isRecord(s) || !isRecord(s.stat)) return null;
          const n = pick<string>(s.stat as Record<string, unknown>, "name");
          const v = toNum(s.base_stat);
          return n && v != null ? `${n}: ${v}` : null;
        })
        .filter(Boolean)
        .join(" · ")
    : null;
  return (
    <div className="space-y-3">
      <div className="flex gap-4 items-start">
        {sprite && <img src={sprite} alt={name} className="size-20 rounded-lg border bg-muted object-contain p-1" />}
        <div className="space-y-1">
          <h4 className="font-semibold text-base capitalize">
            {name} {id != null && <span className="text-muted-foreground font-mono text-xs">#{id}</span>}
          </h4>
          {types && <div className="text-sm text-muted-foreground capitalize">{types}</div>}
          {abilities && <div className="text-xs text-muted-foreground">Abilities: {abilities}</div>}
        </div>
      </div>
      <KeyValueView
        entries={
          [
            ["Tinggi", height != null ? `${height / 10} m` : null],
            ["Berat", weight != null ? `${weight / 10} kg` : null],
            ["Stats", stats],
          ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
        }
      />
    </div>
  );
}

export function CountryView({ data }: { data: Record<string, unknown> }) {
  const rec = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : data;
  const d = isRecord(rec) ? rec : data;
  const name = isRecord(d.name)
    ? (pick<string>(d.name as Record<string, unknown>, "common") ?? pick<string>(d, "name"))
    : pick<string>(d, "name");
  const capital = Array.isArray(d.capital) ? (d.capital as string[]).join(", ") : pick<string>(d, "capital");
  const region = pick<string>(d, "region");
  const subregion = pick<string>(d, "subregion");
  const pop = toNum(pick(d, "population"));
  const area = toNum(pick(d, "area"));
  const flag = isRecord(d.flags)
    ? pick<string>(d.flags as Record<string, unknown>, "png", "svg")
    : pick<string>(d, "flag");
  const currencies = isRecord(d.currencies)
    ? Object.entries(d.currencies as Record<string, unknown>)
        .map(([code, cur]) =>
          isRecord(cur) ? `${code} (${pick<string>(cur as Record<string, unknown>, "name") ?? ""})` : code,
        )
        .join(", ")
    : null;
  const langs = isRecord(d.languages)
    ? Object.values(d.languages as Record<string, unknown>)
        .filter((v): v is string => typeof v === "string")
        .join(", ")
    : null;
  return (
    <div className="space-y-3">
      <div className="flex gap-3 items-center">
        {flag && <img src={flag} alt={name ?? "flag"} className="h-10 w-16 rounded border object-cover" />}
        <h4 className="font-semibold text-base">{name ?? "Country"}</h4>
        {region && <Pill>{[region, subregion].filter(Boolean).join(" · ")}</Pill>}
      </div>
      <KeyValueView
        entries={
          [
            ["Ibu kota", capital],
            ["Populasi", pop != null ? fmtNumber(pop) : null],
            ["Luas", area != null ? `${fmtNumber(area)} km²` : null],
            ["Mata uang", currencies],
            ["Bahasa", langs],
          ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
        }
      />
    </div>
  );
}

export function GithubRepoView({ data }: { data: Record<string, unknown> }) {
  const full =
    pick<string>(data, "full_name", "fullName") ??
    (pick<string>(data, "name") ? `${pick<string>(data, "owner") ?? ""}/${pick<string>(data, "name")}` : null);
  const desc = pick<string>(data, "description");
  const stars = toNum(pick(data, "stargazers_count", "stars"));
  const forks = toNum(pick(data, "forks_count", "forks"));
  const issues = toNum(pick(data, "open_issues_count", "open_issues"));
  const lang = pick<string>(data, "language");
  const license = isRecord(data.license)
    ? pick<string>(data.license as Record<string, unknown>, "name", "spdx_id")
    : pick<string>(data, "license");
  const updated = fmtDate(pick(data, "updated_at", "pushed_at"));
  const url = pick<string>(data, "html_url", "url");
  return (
    <div className="space-y-2">
      <div className="flex items-baseline gap-2 flex-wrap">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="font-mono font-semibold text-sm hover:underline">
            {full ?? "repo"}
          </a>
        ) : (
          <span className="font-mono font-semibold text-sm">{full ?? "repo"}</span>
        )}
        {lang && <Pill>{lang}</Pill>}
        {license && <span className="text-muted-foreground text-xs">{license}</span>}
      </div>
      {desc && <p className="text-sm text-muted-foreground leading-relaxed">{desc}</p>}
      <KeyValueView
        entries={
          [
            ["Stars", stars != null ? fmtNumber(stars) : null],
            ["Forks", forks != null ? fmtNumber(forks) : null],
            ["Open issues", issues != null ? fmtNumber(issues) : null],
            ["Updated", updated],
          ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
        }
      />
    </div>
  );
}

export function CryptoSearchView({ data }: { data: Record<string, unknown> }) {
  const coins = Array.isArray(data.coins) ? data.coins.filter(isRecord) : [];
  if (coins.length === 0) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  return (
    <RecordListView
      items={coins.slice(0, 12).map((c) => ({
        title: `${pick<string>(c, "name") ?? "?"} (${pick<string>(c, "symbol")?.toUpperCase() ?? "?"})`,
        body: `Rank #${toNum(pick(c, "market_cap_rank")) ?? "—"} · id: ${pick<string>(c, "id") ?? "—"}`,
        meta: pick<string>(c, "symbol"),
      }))}
    />
  );
}

export function CryptoMarketView({ data }: { data: unknown }) {
  const arr = Array.isArray(data)
    ? data.filter(isRecord)
    : isRecord(data) && Array.isArray((data as Record<string, unknown>).markets)
      ? ((data as Record<string, unknown>).markets as unknown[]).filter(isRecord)
      : [];
  if (arr.length === 0) return null;
  return (
    <div className="space-y-2">
      <SectionLabel>{arr.length} koin — harga pasar</SectionLabel>
      <ul className="space-y-1.5">
        {arr.slice(0, 12).map((c, i) => {
          const name = pick<string>(c, "name") ?? pick<string>(c, "id") ?? `Coin ${i + 1}`;
          const sym = pick<string>(c, "symbol")?.toUpperCase();
          const price = toNum(pick(c, "current_price", "price", "usd"));
          const change = toNum(pick(c, "price_change_percentage_24h", "price_change_24h"));
          const mcap = toNum(pick(c, "market_cap"));
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: market results may legitimately contain duplicate ids
            <li key={i} className="bg-card rounded-lg border px-3 py-2 flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <div className="font-medium text-sm">
                  {name} {sym && <span className="text-muted-foreground font-mono text-xs">{sym}</span>}
                </div>
                <div className="text-muted-foreground text-xs">
                  {mcap != null ? `MCap ${fmtNumber(mcap, { notation: "compact" })}` : ""}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-sm font-semibold">{price != null ? `$${fmtNumber(price)}` : "—"}</div>
                {change != null && (
                  <div className={`text-xs ${change >= 0 ? "text-success" : "text-destructive"}`}>
                    {change >= 0 ? "▲" : "▼"} {fmtPct(Math.abs(change))}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function TimeZoneView({ data }: { data: Record<string, unknown> }) {
  const dt = pick<string>(data, "dateTime", "datetime", "currentLocalTime", "time");
  const zone = pick<string>(data, "timeZone", "timezone", "zone");
  const dst = data.dstActive ?? data.isDst ?? data.dst;
  return (
    <KeyValueView
      entries={
        [
          ["Waktu lokal", dt ? (fmtDate(dt) ?? dt) : null],
          ["Zona", zone],
          ["DST", typeof dst === "boolean" ? (dst ? "aktif" : "tidak") : dst != null ? String(dst) : null],
        ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
      }
    />
  );
}

export function TopHeadlinesView({ data }: { data: unknown }) {
  return <NewsListView data={data} />;
}

export function DrawCardsView({ data }: { data: Record<string, unknown> }) {
  const cardsArr = Array.isArray(data.cards) ? data.cards.filter(isRecord) : [];
  const remaining = toNum(pick(data, "remaining"));
  if (cardsArr.length === 0) return <GenericHumanView data={data} raw={JSON.stringify(data)} />;
  return (
    <div className="space-y-2">
      <SectionLabel>
        {cardsArr.length} kartu ditarik {remaining != null ? `· sisa ${remaining} kartu` : ""}
      </SectionLabel>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {cardsArr.slice(0, 12).map((c, i) => {
          const code = pick<string>(c, "code", "value");
          const suit = pick<string>(c, "suit");
          const img = pick<string>(c, "image", "images");
          const label = `${pick<string>(c, "value") ?? code ?? "?"} ${suit ?? ""}`.trim();
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: draw results may legitimately contain duplicate codes
            <div key={i} className="bg-card rounded-lg border p-2 text-center">
              {img ? <img src={img} alt={label} className="w-full h-auto rounded" loading="lazy" /> : null}
              <div className="font-mono text-xs mt-1">{label}</div>
              {code && <div className="text-muted-foreground font-mono text-[10px]">{code}</div>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function SunTimesView({ data }: { data: Record<string, unknown> }) {
  const res = isRecord(data.results) ? (data.results as Record<string, unknown>) : data;
  const sunrise = pick<string>(res, "sunrise");
  const sunset = pick<string>(res, "sunset");
  const noon = pick<string>(res, "solar_noon");
  const len = pick<string>(res, "day_length");
  const twilightBegin = pick<string>(res, "civil_twilight_begin");
  const twilightEnd = pick<string>(res, "civil_twilight_end");
  return (
    <KeyValueView
      entries={
        [
          ["Sunrise", sunrise ? (fmtDate(sunrise) ?? sunrise) : null],
          ["Sunset", sunset ? (fmtDate(sunset) ?? sunset) : null],
          ["Solar noon", noon ? (fmtDate(noon) ?? noon) : null],
          [
            "Day length",
            len != null && /^\d+$/.test(len)
              ? `${Math.floor(Number(len) / 3600)}j ${Math.floor((Number(len) % 3600) / 60)}m`
              : len,
          ],
          ["Civil twilight", twilightBegin && twilightEnd ? `${twilightBegin} → ${twilightEnd}` : null],
        ].filter(([, v]) => v != null) as Array<[string, ReactNode]>
      }
    />
  );
}

export function StockFinancialsView({ data }: { data: unknown }) {
  if (isRecord(data) && Array.isArray((data as Record<string, unknown>).statements))
    return <FinancialTableView data={data as Record<string, unknown>} />;
  return <GenericHumanView data={data} raw={typeof data === "string" ? data : JSON.stringify(data)} />;
}
