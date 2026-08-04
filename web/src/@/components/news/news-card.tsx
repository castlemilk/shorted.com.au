import Link from "next/link";
import { ExternalLink, Megaphone } from "lucide-react";
import { NewsImage } from "~/@/components/news/news-image";
import { NewsSourceBadge } from "~/@/components/ui/news-source-badge";
import { SentimentBadge } from "~/@/components/ui/sentiment-badge";
import { cn } from "~/@/lib/utils";
import { formatRelativeTime } from "~/@/lib/relative-time";
import { isValidStockCode } from "~/@/lib/stock-code";
import { stockChipPalette } from "~/@/lib/stock-color";

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
  syndicationCount?: number;
  syndicatedSources?: string[];
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
      return "border-l-border";
  }
};

export function NewsCard({ article, variant = "default", showStockChip = true, className }: NewsCardProps) {
  const time = formatRelativeTime(new Date(article.publishedAt));
  const isHero = variant === "hero";
  const isCompact = variant === "compact";
  const syndicationLabel =
    (article.syndicatedSources?.length ?? 0) > 0
      ? `Also covered by ${article.syndicatedSources!.join(", ")}`
      : undefined;

  return (
    <article
      className={cn(
        // Flat at rest, amber on hover — the wire card's response, not a grey
        // drop shadow. The sentiment `border-l-4` stripe is untouched.
        "group relative overflow-hidden rounded-xl border-l-4 border bg-card transition-shadow duration-200 ease-out hover:shadow-amber-sm",
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
          // The image is decorative (alt=""); the link needs its own
          // accessible name or screen readers / crawlers see an empty link
          // ("Links must have discernible text"). Mirror the headline.
          aria-label={article.headline}
          className={cn(
            // `relative` + a locked aspect ratio give the slot intrinsic
            // height before the image loads (prevents CLS) and position the
            // next/image `fill` layer.
            "relative block shrink-0 overflow-hidden bg-muted aspect-[16/9]",
            isHero && "md:w-[40%] md:aspect-[5/3]",
          )}
        >
          <NewsImage
            src={article.imageUrl}
            alt=""
            // Grid cards: full-width on phones, 2-up on tablets, 3-up on
            // desktop. Hero: ~40% of the container on md+.
            sizes={
              isHero
                ? "(max-width: 768px) 100vw, 40vw"
                : "(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            }
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.02]"
          />
        </a>
      )}

      <div className={cn("flex flex-1 flex-col gap-2 p-4", isHero && "md:p-5")}>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <NewsSourceBadge source={article.source} />
          {(article.syndicationCount ?? 1) > 1 && (
            <span
              className="text-[10px] uppercase tracking-wide text-muted-foreground"
              title={syndicationLabel}
              aria-label={syndicationLabel}
            >
              +{(article.syndicationCount ?? 1) - 1} source{(article.syndicationCount ?? 1) > 2 ? "s" : ""}
            </span>
          )}
          {article.isPriceSensitive && (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300">
              <Megaphone className="h-3 w-3" />
              Price sensitive
            </span>
          )}
          {showStockChip && isValidStockCode(article.stockCode) && (
            <Link
              href={`/shorts/${article.stockCode}`}
              className={cn(
                "inline-flex items-center rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wide transition-opacity hover:opacity-80",
                stockChipPalette(article.stockCode).onCard,
              )}
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
