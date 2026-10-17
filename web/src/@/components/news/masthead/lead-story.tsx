import Image from "next/image";
import Link from "next/link";
import { cn } from "~/@/lib/utils";
import { eyebrow, sectionTitle } from "~/@/lib/typography";
import {
  beatFromByline,
  fmtTakeDate,
  sentimentText,
  type TakeLike,
} from "./shared";

/**
 * LeadStory — the front-page splash: full-width 16:9 image (or quiet
 * fallback with the stock code, matching take-hero), caption/credit below
 * the image, beat tag, big serif headline, standfirst and a meta row.
 */
export function LeadStory({ take }: { take: TakeLike }) {
  const beat = beatFromByline(take.byline);
  const sent = sentimentText(take.sentiment);
  const date = fmtTakeDate(take.publishedAt);

  return (
    <article>
      <Link href={`/news/${take.slug}`} className="group block rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring">
        <figure>
          {take.heroImageUrl ? (
            <div className="relative aspect-video overflow-hidden rounded-lg border border-border bg-muted">
              <Image
                src={take.heroImageUrl}
                alt=""
                fill
                priority
                sizes="(max-width: 768px) 100vw, (max-width: 1280px) 75vw, 896px"
                className="object-cover"
              />
            </div>
          ) : (
            <div className="flex aspect-video items-center justify-center overflow-hidden rounded-lg border border-border bg-muted">
              {take.stockCode ? (
                <span
                  className="font-mono text-5xl font-semibold tracking-tight text-muted-foreground md:text-7xl"
                >
                  ${take.stockCode}
                </span>
              ) : (
                <span className="font-mono text-sm text-muted-foreground">
                  Shorted Take
                </span>
              )}
            </div>
          )}

          {(take.heroCaption ?? take.heroCredit) && (
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
          )}
        </figure>

        <div className="mt-5 space-y-3">
          {beat ? (
            <p className={cn(eyebrow, "font-medium text-primary")}>
              {beat}
            </p>
          ) : null}

          <h2 className={cn(sectionTitle, "text-3xl leading-[1.08] transition-colors group-hover:text-primary md:text-5xl")}>
            {take.headline}
          </h2>

          {take.standfirst ? (
            <p className="max-w-3xl font-serif text-lg leading-snug text-muted-foreground md:text-xl">
              {take.standfirst}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 font-mono text-xs tabular-nums text-muted-foreground">
            {take.byline ? (
                <span className="text-foreground">{take.byline}</span>
            ) : null}
            {date ? (
                <span>{date}</span>
            ) : null}
            <span className={sent.className}>{sent.label}</span>
          </div>
        </div>
      </Link>
    </article>
  );
}
