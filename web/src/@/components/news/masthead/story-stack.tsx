import Image from "next/image";
import Link from "next/link";
import { cn } from "~/@/lib/utils";
import { eyebrow, sectionTitle } from "~/@/lib/typography";
import { beatFromByline, fmtTakeDate, type TakeLike } from "./shared";

/**
 * StoryStack — vertical run of secondary editorial takes, hairline-ruled,
 * each with a serif headline and a static 16:9 thumbnail on the right.
 */
export function StoryStack({ takes }: { takes: TakeLike[] }) {
  if (takes.length === 0) return null;

  return (
    <div>
      {takes.map((take) => {
        const beat = beatFromByline(take.byline);
        return (
          <Link
            key={take.id}
            href={`/news/${take.slug}`}
            className="group grid grid-cols-[minmax(0,1fr),112px] gap-4 rounded-sm border-b border-border py-5 first:pt-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring sm:grid-cols-[minmax(0,1fr),160px]"
          >
            <div className="min-w-0 space-y-2">
              {beat ? (
                <p className={cn(eyebrow, "font-medium text-primary")}>
                  {beat}
                </p>
              ) : null}
              <h2 className={cn(sectionTitle, "text-xl leading-snug transition-colors group-hover:text-primary md:text-2xl")}>
                {take.headline}
              </h2>
              {take.standfirst ? (
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {take.standfirst}
                </p>
              ) : null}
              <p className="font-mono text-xs tabular-nums text-muted-foreground">
                {fmtTakeDate(take.publishedAt)}
              </p>
            </div>

            <div>
              {take.heroImageUrl ? (
                <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-muted">
                  <Image
                    src={take.heroImageUrl}
                    alt=""
                    fill
                    sizes="(max-width: 640px) 112px, 160px"
                    className="object-cover"
                  />
                </div>
              ) : (
                <div className="flex aspect-video w-full items-center justify-center rounded-lg border border-border bg-muted">
                  <span className="font-mono text-lg font-semibold text-muted-foreground">
                    {take.stockCode ? `$${take.stockCode}` : "Take"}
                  </span>
                </div>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}
