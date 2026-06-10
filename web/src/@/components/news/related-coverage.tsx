import { type NewsArticle } from "~/gen/shorts/v1alpha1/shorts_pb";
import { getStockNews } from "~/app/actions/getStockNews";

const fmtShortDate = (ts: { seconds?: bigint | number } | undefined): string => {
  if (!ts?.seconds) return "";
  const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : ts.seconds;
  return new Date(s * 1000).toLocaleDateString("en-AU", {
    timeZone: "Australia/Sydney",
    day: "numeric",
    month: "short",
  });
};

/**
 * RelatedCoverage — compact wire-style list of recent external news for
 * the take's stock, rendered under the article body. Mirrors the row
 * idiom of masthead/wire-list.tsx (date gutter, headline link, source
 * line). Renders nothing when the fetch fails or comes back empty.
 */
export async function RelatedCoverage({
  stockCode,
  excludeUrl,
}: {
  stockCode: string;
  excludeUrl?: string;
}) {
  if (!stockCode) return null;

  let articles: NewsArticle[] = [];
  try {
    const resp = await getStockNews(stockCode, 6);
    articles = resp?.articles ?? [];
  } catch {
    return null;
  }

  // Skip the current article's source and collapse syndicated duplicates
  // (same story carried by multiple mastheads) down to one row.
  const seen = new Set<string>();
  const rows = articles
    .filter((a) => {
      if (!a.url || (excludeUrl && a.url === excludeUrl)) return false;
      const key = a.headline.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 5);
  if (rows.length === 0) return null;

  return (
    <section className="mt-12 border-t border-border pt-6">
      <h2 className="font-serif text-lg">More on {stockCode}</h2>
      <ul className="mt-2">
        {rows.map((article) => {
          // GetStockNews doesn't always populate published_at — drop the
          // date gutter entirely rather than render an empty column.
          const date = fmtShortDate(article.publishedAt);
          return (
            <li
              key={article.id || article.url}
              className="flex gap-3 border-b border-border/40 py-3 last:border-b-0"
            >
              {date ? (
                <span className="w-12 shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">
                  {date}
                </span>
              ) : null}
              <div className="min-w-0">
                <a
                  href={article.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block text-sm leading-snug transition-colors hover:text-primary"
                >
                  {article.headline}
                </a>
                <p className="mt-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                  {article.source}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
