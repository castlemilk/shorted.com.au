import Image from "next/image";
import Link from "next/link";
import { stockChipPalette } from "~/@/lib/stock-color";
import { beatFromByline, fmtTakeDate, type TakeLike } from "./shared";

/**
 * StoryStack — vertical run of secondary editorial takes, hairline-ruled,
 * each with a serif headline and a small 3:2 thumbnail on the right.
 */
export function StoryStack({ takes }: { takes: TakeLike[] }) {
  if (takes.length === 0) return null;

  return (
    <div>
      {takes.map((take) => {
        const beat = beatFromByline(take.byline);
        const chip = stockChipPalette(take.stockCode);
        return (
          <Link
            key={take.id}
            href={`/news/${take.slug}`}
            className="group grid gap-4 border-b border-border py-5 first:pt-0 md:grid-cols-[1fr,160px]"
          >
            <div className="space-y-2">
              {beat ? (
                <p className="text-[11px] uppercase tracking-[0.2em] text-primary">
                  {beat}
                </p>
              ) : null}
              <h2 className="font-serif text-xl font-medium leading-snug transition-colors group-hover:text-primary md:text-2xl">
                {take.headline}
              </h2>
              {take.standfirst ? (
                <p className="line-clamp-2 text-sm text-muted-foreground">
                  {take.standfirst}
                </p>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {fmtTakeDate(take.publishedAt)}
              </p>
            </div>

            <div className="hidden md:block">
              {take.heroImageUrl ? (
                <div className="relative aspect-[3/2] w-[160px] overflow-hidden bg-muted/20">
                  <Image
                    src={take.heroImageUrl}
                    alt=""
                    fill
                    sizes="160px"
                    className="object-cover transition-transform duration-500 group-hover:scale-[1.04]"
                  />
                </div>
              ) : (
                <div className="flex aspect-[3/2] w-[160px] items-center justify-center bg-gradient-to-br from-orange-950/40 via-zinc-950 to-zinc-950">
                  <span
                    className={`font-mono text-lg font-bold ${
                      chip.onImage
                        .split(" ")
                        .find((c) => c.startsWith("text-")) ??
                      "text-orange-300/80"
                    }`}
                  >
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
