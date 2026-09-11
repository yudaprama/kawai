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
