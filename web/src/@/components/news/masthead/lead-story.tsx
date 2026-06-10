import Link from "next/link";
import { stockChipPalette } from "~/@/lib/stock-color";
import {
  beatFromByline,
  fmtTakeDate,
  sentimentText,
  type TakeLike,
} from "./shared";

/**
 * LeadStory — the front-page splash: full-width 16:9 image (or gradient
 * fallback with the stock code, matching take-hero), caption/credit below
 * the image, beat tag, big serif headline, standfirst and a meta row.
 */
export function LeadStory({ take }: { take: TakeLike }) {
  const beat = beatFromByline(take.byline);
  const sent = sentimentText(take.sentiment);
  const chip = stockChipPalette(take.stockCode);
  const date = fmtTakeDate(take.publishedAt);

  return (
    <article>
      <Link href={`/news/${take.slug}`} className="group block">
        <figure>
          {take.heroImageUrl ? (
            <div className="aspect-[16/9] overflow-hidden bg-muted/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={take.heroImageUrl}
                alt={take.headline}
                loading="eager"
                decoding="async"
                className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.02]"
              />
            </div>
          ) : (
            <div className="relative flex aspect-[16/9] items-center justify-center overflow-hidden bg-gradient-to-br from-orange-950/40 via-zinc-950 to-zinc-950">
              <div
                className="pointer-events-none absolute inset-0 opacity-30"
                style={{
                  backgroundImage:
                    "radial-gradient(circle at 20% 30%, rgba(255,169,77,0.15), transparent 50%), radial-gradient(circle at 80% 70%, rgba(255,169,77,0.08), transparent 60%)",
                }}
              />
              {take.stockCode ? (
                <span
                  className={`relative font-mono text-5xl font-bold tracking-tight md:text-7xl ${
                    chip.onImage
                      .split(" ")
                      .find((c) => c.startsWith("text-")) ??
                    "text-orange-300/80"
                  }`}
                >
                  ${take.stockCode}
                </span>
              ) : (
                <span className="relative text-xs font-medium uppercase tracking-[0.2em] text-orange-300/70">
                  Shorted Take
                </span>
              )}
            </div>
          )}

          {(take.heroCaption || take.heroCredit) && (
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
          )}
        </figure>

        <div className="mt-5 space-y-3">
          {beat ? (
            <p className="text-[11px] uppercase tracking-[0.2em] text-primary">
              {beat}
            </p>
          ) : null}

          <h2 className="font-serif text-3xl font-semibold leading-[1.05] tracking-tight transition-colors group-hover:text-primary md:text-5xl">
            {take.headline}
          </h2>

          {take.standfirst ? (
            <p className="max-w-3xl font-serif text-lg leading-snug text-muted-foreground md:text-xl">
              {take.standfirst}
            </p>
          ) : null}

          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            {take.byline ? (
              <>
                <span className="text-foreground">{take.byline}</span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            {date ? (
              <>
                <span>{date}</span>
                <span aria-hidden>·</span>
              </>
            ) : null}
            <span className={sent.className}>{sent.label}</span>
          </div>
        </div>
      </Link>
    </article>
  );
}
