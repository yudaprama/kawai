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
          <div className="bg-background/50 border-border/60 rounded-lg border p-3" key={`${e.run ?? "run"}-${i}`}>
            <div className="text-muted-foreground mb-1.5 flex flex-wrap items-center gap-2 font-mono text-[11px]">
              <span className="text-foreground/80 font-semibold">{tool === "deliverable_writer" ? "Deliverable" : tool}</span>
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
