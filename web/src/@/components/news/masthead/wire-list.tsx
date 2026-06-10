import { type NewsCardArticle } from "~/@/components/news/news-card";

const sentimentDot = (sentiment?: string) => {
  switch (sentiment) {
    case "positive":
      return "bg-emerald-500";
    case "negative":
      return "bg-rose-500";
    default:
      return "bg-slate-500";
  }
};

const fmtTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-AU", {
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * WireList — the aggregated news feed rendered as a compact newspaper
 * "wire" column, grouped by day.
 */
export function WireList({
  groups,
}: {
  groups: Record<string, NewsCardArticle[]>;
}) {
  const dayLabels = Object.keys(groups);
  if (dayLabels.length === 0) return null;

  return (
    <aside>
      <div className="border-b border-border pb-2">
        <h2 className="font-serif text-lg">The Wire</h2>
      </div>

      {dayLabels.map((label) => (
        <section key={label}>
          <h3 className="border-b border-border/60 py-2 text-[11px] uppercase tracking-[0.2em] text-muted-foreground">
            {label}
          </h3>
          <ul>
            {groups[label]!.map((article) => {
              const syndicationCount = article.syndicationCount ?? 1;
              const syndicationLabel =
                (article.syndicatedSources?.length ?? 0) > 0
                  ? `Also covered by ${article.syndicatedSources!.join(", ")}`
                  : undefined;
              return (
                <li
                  key={article.id}
                  className="flex gap-3 border-b border-border/40 py-3 last:border-b-0"
                >
                  <span className="w-12 shrink-0 pt-0.5 font-mono text-[11px] text-muted-foreground">
                    {fmtTime(article.publishedAt)}
                  </span>
                  <span
                    className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${sentimentDot(article.sentiment)}`}
                    aria-hidden
                  />
                  <div className="min-w-0">
                    <a
                      href={article.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block text-sm leading-snug transition-colors hover:text-primary"
                    >
                      {article.headline}
                    </a>
                    <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <span>{article.source}</span>
                      {syndicationCount > 1 && (
                        <span title={syndicationLabel} aria-label={syndicationLabel}>
                          +{syndicationCount - 1} source
                          {syndicationCount > 2 ? "s" : ""}
                        </span>
                      )}
                      {article.isPriceSensitive && (
                        <span
                          className="font-mono text-amber-400"
                          title="Price sensitive"
                          aria-label="Price sensitive"
                        >
                          PS
                        </span>
                      )}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
