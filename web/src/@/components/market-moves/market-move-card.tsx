import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { cn } from "~/@/lib/utils";
import { stockTabHref } from "~/@/lib/stocks/stock-tabs";
import { safeExternalHref } from "~/@/lib/safe-external-href";
import type { MarketMoveView } from "~/@/lib/market-moves/view";
import {
  DIRECTION_WORD,
  MOVE_STRIPE,
  MOVE_TONE,
  formatMoveChange,
  formatMovePrice,
  formatObservedAt,
  formatVolumeRatio,
  indexName,
} from "~/@/lib/market-moves/format";

/**
 * One market move, as the market-moves workflow posted it. A server component:
 * no client JS, no Connect, only the plain MarketMoveView.
 *
 * Plain text throughout (the API stores text, never HTML or markdown); the
 * summary keeps the poster's line breaks. Every move says it is not advice and
 * carries its own observation time. The card names no author: the /market-moves
 * page says the moves are AI-written.
 */
export interface MarketMoveCardProps {
  move: MarketMoveView;
  /**
   * full: the /market-moves feed (summary, sources, tags).
   * compact: the homepage strip and a stock page (summary clamped, no sources;
   * the headline links to the move on the feed).
   */
  variant?: "full" | "compact";
  /** The stock page the card sits on: its own code is printed, not linked. */
  currentStockCode?: string;
  /** The heading level of the headline, so each page keeps its outline. */
  headingLevel?: 2 | 3 | 4;
  className?: string;
}

/** The link to a move on the feed page (the API's URL anchor). */
export function marketMoveHref(moveKey: string): string {
  return `/market-moves#move-${moveKey}`;
}

function StockCodeLink({
  code,
  currentStockCode,
}: {
  code: string;
  currentStockCode?: string;
}) {
  if (code === currentStockCode) {
    return <span className="font-mono font-semibold">{code}</span>;
  }
  return (
    <Link
      href={stockTabHref(code, "overview")}
      prefetch={false}
      className="font-mono font-semibold text-primary hover:underline"
    >
      {code}
    </Link>
  );
}

function Subject({
  move,
  currentStockCode,
}: {
  move: MarketMoveView;
  currentStockCode?: string;
}) {
  switch (move.kind) {
    case "stock":
      return (
        <span className="flex min-w-0 items-baseline gap-1.5">
          {move.stockCode ? (
            <StockCodeLink
              code={move.stockCode}
              currentStockCode={currentStockCode}
            />
          ) : null}
          {move.companyName ? (
            <span className="truncate text-muted-foreground">
              {move.companyName}
            </span>
          ) : null}
        </span>
      );
    case "index": {
      const name = move.indexCode ? indexName(move.indexCode) : null;
      return (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="font-mono font-semibold">{move.indexCode}</span>
          <span className="truncate text-muted-foreground">
            {name ?? "index"}
          </span>
        </span>
      );
    }
    case "sector":
      return (
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="font-semibold">{move.sector}</span>
          <span className="text-muted-foreground">sector</span>
        </span>
      );
    default:
      return <span className="font-semibold">ASX market</span>;
  }
}

export function MarketMoveCard({
  move,
  variant = "full",
  currentStockCode,
  headingLevel = 3,
  className,
}: MarketMoveCardProps) {
  const compact = variant === "compact";
  const Heading = `h${headingLevel}` as "h2" | "h3" | "h4";
  const price = formatMovePrice(move);
  const volume = formatVolumeRatio(move.volumeRatio);
  const observed = formatObservedAt(move.observedAt);

  return (
    <article
      id={`move-${move.moveKey}`}
      data-move-key={move.moveKey}
      className={cn(
        "scroll-mt-[124px] rounded-xl border border-l-4 bg-card",
        compact ? "px-4 py-3" : "p-4",
        MOVE_STRIPE[move.direction],
        className,
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <Subject move={move} currentStockCode={currentStockCode} />
        <span
          className={cn(
            "font-mono font-semibold tabular-nums",
            MOVE_TONE[move.direction],
          )}
          data-testid="move-change"
        >
          {move.changePct != null
            ? formatMoveChange(move.changePct)
            : DIRECTION_WORD[move.direction]}
        </span>
        {price ? (
          <span
            className="font-mono text-xs tabular-nums text-muted-foreground"
            data-testid="move-price"
          >
            {price}
          </span>
        ) : null}
        {volume ? (
          <span
            className="text-xs text-muted-foreground"
            data-testid="move-volume"
          >
            {volume}
          </span>
        ) : null}
      </div>

      <Heading
        className={cn(
          "mt-1.5 font-semibold leading-snug text-foreground",
          compact ? "text-sm" : "text-base",
        )}
      >
        {compact ? (
          <Link
            href={marketMoveHref(move.moveKey)}
            prefetch={false}
            className="hover:text-primary hover:underline"
          >
            {move.headline}
          </Link>
        ) : (
          move.headline
        )}
      </Heading>

      {move.summary ? (
        <p
          className={cn(
            "mt-1.5 whitespace-pre-line text-sm leading-relaxed text-muted-foreground",
            compact && "line-clamp-3",
          )}
        >
          {move.summary}
        </p>
      ) : null}

      {move.relatedCodes.length > 0 ? (
        <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span>Also moving:</span>
          {move.relatedCodes.map((code) => (
            <StockCodeLink
              key={code}
              code={code}
              currentStockCode={currentStockCode}
            />
          ))}
        </p>
      ) : null}

      {!compact && move.sources.length > 0 ? (
        <ul className="mt-2 space-y-1 text-xs" aria-label="Sources">
          {move.sources.map((source) => {
            // The view already keeps only http(s) sources; this is the house
            // rule for any href taken from data (SEC-07), kept where it is read.
            const href = safeExternalHref(source.url);
            if (!href) return null;
            return (
              <li key={source.url}>
                <a
                  href={href}
                  target="_blank"
                  rel="nofollow noopener noreferrer ugc"
                  className="inline-flex items-baseline gap-1 text-primary hover:underline"
                >
                  <span>{source.title}</span>
                  {source.publisher ? (
                    <span className="text-muted-foreground">
                      ({source.publisher})
                    </span>
                  ) : null}
                  <ExternalLink
                    className="h-3 w-3 shrink-0 self-center"
                    aria-hidden="true"
                  />
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}

      {!compact && move.tags.length > 0 ? (
        <ul className="mt-2 flex flex-wrap gap-1.5" aria-label="Tags">
          {move.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-sm border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
            >
              {tag}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="mt-2 text-[11px] leading-4 text-muted-foreground">
        <time dateTime={move.observedAt}>{observed}</time>
        {move.revision > 1 ? <span> · Updated</span> : null}
        <span> · Not financial advice</span>
      </p>
    </article>
  );
}
