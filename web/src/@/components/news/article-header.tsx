import Image from "next/image";
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
    meta.push(<span key="read">{minutes} min read</span>);
  }

  return (
    <header className="mb-8">
      {beat ? (
        <p className="mb-3 text-[11px] uppercase tracking-[0.2em] text-primary">
          {beat}
        </p>
      ) : null}

      <h1 className="font-serif text-3xl font-semibold leading-[1.05] tracking-tight md:text-5xl">
        {take.headline}
      </h1>

      {take.standfirst ? (
        <p className="mt-4 max-w-3xl font-serif text-lg leading-snug text-muted-foreground md:text-xl">
          {take.standfirst}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        {meta.flatMap((node, i) =>
          i === 0
            ? [node]
            : [
                <span key={`sep-${i}`} aria-hidden>
                  ·
                </span>,
                node,
              ],
        )}
      </div>

      {take.heroImageUrl ? (
        <figure className="mt-8">
          <div className="relative aspect-[16/9] overflow-hidden rounded bg-muted/20">
            <Image
              src={take.heroImageUrl}
              alt={take.heroCaption ? take.heroCaption : take.headline}
              fill
              priority
              sizes="(max-width: 768px) 100vw, 896px"
              className="object-cover"
            />
          </div>
          {Boolean(take.heroCaption) || Boolean(take.heroCredit) ? (
            <figcaption className="mt-2 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              {take.heroCaption ? (
                <span className="text-xs text-muted-foreground">
                  {take.heroCaption}
                </span>
              ) : null}
              {take.heroCredit ? (
                <span className="ml-auto text-[10px] uppercase tracking-wider text-muted-foreground">
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
