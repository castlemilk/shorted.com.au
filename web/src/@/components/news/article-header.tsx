import Image from "next/image";
import { cn } from "~/@/lib/utils";
import { eyebrow, lede, pageTitle } from "~/@/lib/typography";
import { beatFromByline, fmtTakeDate } from "./masthead/shared";

/**
 * Structural subset of EditorialTake the header needs — typed loosely so
 * the component accepts both the generated protobuf message and plain
 * objects (tests, cached/serialized takes).
 */
export interface ArticleHeaderTake {
  headline: string;
  standfirst?: string;
  byline?: string;
  heroImageUrl?: string;
  heroCaption?: string;
  heroCredit?: string;
  wordCount?: number;
  publishedAt?: { seconds?: bigint | number };
}

function publishedISO(ts: { seconds?: bigint | number } | undefined): string {
  if (!ts?.seconds) return "";
  const s = typeof ts.seconds === "bigint" ? Number(ts.seconds) : ts.seconds;
  return new Date(s * 1000).toISOString();
}

/**
 * ArticleHeader — masthead-style article opener for /news/[slug]:
 * beat tag → serif display headline → standfirst → meta row (byline ·
 * date · read time) → hero figure with caption/credit.
 *
 * Degrades gracefully for legacy takes: standfirst/byline/caption/credit
 * simply don't render when absent.
 */
export function ArticleHeader({ take }: { take: ArticleHeaderTake }) {
  const beat = beatFromByline(take.byline);
  const date = fmtTakeDate(take.publishedAt);
  const iso = publishedISO(take.publishedAt);
  const minutes =
    take.wordCount && take.wordCount > 0
      ? Math.max(1, Math.round(take.wordCount / 220))
      : 0;

  const meta: React.ReactNode[] = [];
  meta.push(
    <span key="byline" className="text-foreground">
      {take.byline ? take.byline : "Shorted Editorial"}
    </span>,
  );
  if (date) {
    meta.push(
      <time key="date" dateTime={iso}>
        {date}
      </time>,
    );
  }
  if (minutes > 0) {
    meta.push(<span key="read" className="tabular-nums">{minutes} min read</span>);
  }

  return (
    <header className="mx-auto mb-10 max-w-[54rem]">
      {beat ? (
        <p className={cn(eyebrow, "mb-3 font-medium text-primary")}>
          {beat}
        </p>
      ) : null}

      <h1 className={cn(pageTitle, "leading-[1.08] md:text-5xl")}>
        {take.headline}
      </h1>

      {take.standfirst ? (
        <p className={cn(lede, "article-summary mt-5 font-serif text-xl leading-relaxed md:text-2xl")}>
          {take.standfirst}
        </p>
      ) : null}

      <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-border py-4 font-mono text-xs text-muted-foreground">
        {meta}
      </div>

      {take.heroImageUrl ? (
        <figure className="mt-8">
          <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-muted">
            <Image
              src={take.heroImageUrl}
              alt={take.heroCaption ? take.heroCaption : take.headline}
              fill
              priority
              sizes="(max-width: 864px) 100vw, 864px"
              className="object-cover"
            />
          </div>
          {Boolean(take.heroCaption) || Boolean(take.heroCredit) ? (
            <figcaption className="mt-3 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 font-mono leading-relaxed">
              {take.heroCaption ? (
                <span className="text-xs text-muted-foreground">
                  {take.heroCaption}
                </span>
              ) : null}
              {take.heroCredit ? (
                <span className="ml-auto text-xs text-muted-foreground">
                  {take.heroCredit}
                </span>
              ) : null}
            </figcaption>
          ) : null}
        </figure>
      ) : null}
    </header>
  );
}
