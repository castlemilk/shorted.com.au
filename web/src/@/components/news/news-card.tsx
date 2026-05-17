import Link from "next/link";
import { ExternalLink, Megaphone } from "lucide-react";
import { NewsSourceBadge } from "~/@/components/ui/news-source-badge";
import { SentimentBadge } from "~/@/components/ui/sentiment-badge";
import { cn } from "~/@/lib/utils";

export interface NewsCardArticle {
  id: string;
  headline: string;
  url: string;
  source: string;
  publishedAt: string;
  sentiment?: string;
  summary?: string;
  imageUrl?: string;
  stockCode?: string;
  isPriceSensitive?: boolean;
}

interface NewsCardProps {
  article: NewsCardArticle;
  variant?: "default" | "hero" | "compact";
  showStockChip?: boolean;
  className?: string;
}

const sentimentBorder = (sentiment?: string) => {
  switch (sentiment) {
    case "positive":
      return "border-l-emerald-500/60";
    case "negative":
      return "border-l-rose-500/60";
    default:
      return "border-l-slate-300/40 dark:border-l-slate-700/40";
  }
};

const formatRelativeTime = (iso: string): string => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 60) return `${Math.max(1, mins)}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-AU", { day: "numeric", month: "short" });
};

export function NewsCard({ article, variant = "default", showStockChip = true, className }: NewsCardProps) {
  const time = formatRelativeTime(article.publishedAt);
  const isHero = variant === "hero";
  const isCompact = variant === "compact";

  return (
    <article
      className={cn(
        "group relative overflow-hidden rounded-xl border-l-4 border bg-card transition-all hover:shadow-md",
        sentimentBorder(article.sentiment),
        isHero && "md:flex md:gap-5",
        className,
      )}
    >
      {article.imageUrl && !isCompact && (
        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            "block shrink-0 overflow-hidden bg-muted",
            isHero ? "md:w-[40%] aspect-[16/9] md:aspect-auto" : "aspect-[16/9]",
          )}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={article.imageUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
          />
        </a>
      )}

      <div className={cn("flex flex-1 flex-col gap-2 p-4", isHero && "md:p-5")}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <NewsSourceBadge source={article.source} />
          {article.isPriceSensitive && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              <Megaphone className="h-3 w-3" />
              Price sensitive
            </span>
          )}
          {showStockChip && article.stockCode && article.stockCode !== "MARKET" && (
            <Link
              href={`/shorts/${article.stockCode}`}
              className="inline-flex items-center rounded-full border border-border bg-muted/50 px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide text-foreground transition-colors hover:bg-muted"
            >
              ${article.stockCode}
            </Link>
          )}
          {article.sentiment && <SentimentBadge sentiment={article.sentiment} />}
          <span className="ml-auto text-muted-foreground">{time}</span>
        </div>

        <a
          href={article.url}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          <h3
            className={cn(
              "font-semibold leading-snug tracking-tight text-foreground transition-colors group-hover:text-primary",
              isHero ? "text-xl md:text-2xl" : "text-base md:text-lg",
              isCompact && "text-sm",
            )}
          >
            {article.headline}
          </h3>
        </a>

        {!isCompact && article.summary && (
          <p
            className={cn(
              "text-sm leading-relaxed text-muted-foreground",
              isHero ? "line-clamp-3" : "line-clamp-2",
            )}
          >
            {article.summary}
          </p>
        )}

        <div className="mt-auto flex items-center gap-1 pt-1 text-[11px] text-muted-foreground">
          <a
            href={article.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 hover:text-foreground"
          >
            Continue reading
            <ExternalLink className="h-3 w-3" />
          </a>
        </div>
      </div>
    </article>
  );
}
