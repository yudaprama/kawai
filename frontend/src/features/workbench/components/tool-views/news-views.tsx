import { fmtDate, isRecord, pick } from "./format";
import { SectionLabel } from "./atoms";

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

/** get_stock_news / get_reddit_posts — headline cards. */
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

// ── market-squawk ────────────────────────────────────────────────────────────
//
// market_squawk  → {"source":"financialjuice",...,"items":[...]}
// market_squawk_search → {"query":"…","note":"…","items":[...]}
// NewsItem shape (crates/integrations/financialjuice/src/lib.rs):
//   {id,title,summary,source,domain,url,published_at}

interface SquawkItem {
  id: string;
  title: string;
  summary?: string;
  url?: string;
  published_at?: string;
}

function squawkItems(data: unknown): {
  header: string | null;
  note: string | null;
  items: SquawkItem[];
} {
  if (!isRecord(data)) return { header: null, note: null, items: [] };
  const raw = Array.isArray(data.items) ? data.items.filter(isRecord) : [];
  const items: SquawkItem[] = [];
  for (const r of raw) {
    const title = pick<string>(r, "title", "headline");
    // Title-less item = degraded partial from a truncated preview repair —
    // skip it instead of rendering a fabricated placeholder.
    if (!title) continue;
    items.push({
      id: pick<string>(r, "id") ?? title,
      title,
      summary: pick<string>(r, "summary", "body"),
      url: pick<string>(r, "url", "link"),
      published_at: pick<string>(r, "published_at", "publishedAt"),
    });
  }
  const query = pick<string>(data, "query");
  const header = query ? `Hasil pencarian squawk: "${query}"` : null;
  const note = pick<string>(data, "note") ?? null;
  return { header, note, items };
}

/** market_squawk / market_squawk_search — FinancialJuice headline stream with
 *  a source / cache note. */
export function MarketSquawkView({ data }: { data: unknown }) {
  const { header, note, items } = squawkItems(data);
  if (items.length === 0) return null;
  const label = header ?? `${items.length} squawk ditemukan`;
  return (
    <div className="space-y-2">
      <SectionLabel>{label}</SectionLabel>
      {note && <p className="text-muted-foreground font-mono text-[10px]">{note}</p>}
      <ul className="space-y-2">
        {items.slice(0, 20).map((it) => {
          const date = fmtDate(it.published_at);
          return (
            <li className="bg-card rounded-lg border p-3" key={it.id}>
              <div className="flex items-start gap-2.5">
                <div className="min-w-0 flex-1">
                  {it.url ? (
                    <a
                      className="text-foreground text-sm font-medium hover:underline"
                      href={it.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {it.title}
                    </a>
                  ) : (
                    <span className="text-foreground text-sm font-medium">{it.title}</span>
                  )}
                  {it.summary && <p className="text-muted-foreground mt-1 text-sm leading-relaxed">{it.summary}</p>}
                </div>
                {date && (
                  <span className="text-muted-foreground shrink-0 whitespace-nowrap pt-0.5 font-mono text-[10px]">
                    {date}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
