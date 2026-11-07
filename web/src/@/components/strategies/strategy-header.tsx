import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { pageTitle } from "~/@/lib/typography";
import { getStrategy } from "~/@/lib/strategies/registry";
import {
  StrategyArtBand,
  hasStrategyArt,
} from "~/@/components/picks/strategy-art";
import { StrategyBezel } from "~/@/components/picks/strategy-glyph";
import { buttonVariants } from "~/@/components/ui/button";
import { strategyCapabilityEnabled } from "~/@/lib/strategies/capabilities";

/**
 * The strategy profile's faceplate: the glyph in its bezel beside the serif H1
 * and the dek, on the strategy's art when it has any. It is the stage the
 * scene's pointer reads (data-scene-stage), so a pointer over the H1 plays it.
 *
 * Server-rendered from the registry alone: the name, the dek and the art are
 * static, so the layout that renders it reads nothing and cannot fail a render.
 * The author, the provenance and the rest of the data belong to the Overview.
 *
 * The Compare button is drawn only while the `compare` capability is on
 * (lib/strategies/capabilities.ts); it opens the compare page with this strategy ticked.
 * Create alert arrives with its own capability and is not drawn yet.
 */
export function StrategyHeader({ slug }: { slug: string }) {
  const seo = getStrategy(slug);
  if (!seo) return null;
  const hasArt = hasStrategyArt(seo.slug);

  return (
    <section
      data-scene-stage={hasArt ? "" : undefined}
      className={cn(
        "mb-4 motion-safe:animate-phosphor-warm",
        hasArt
          ? "relative overflow-hidden rounded-lg border border-border/60 p-4 sm:p-6"
          : "border-b border-border/40 pb-6",
      )}
    >
      <StrategyArtBand slug={seo.slug} />
      <div className="relative flex items-start gap-4 sm:gap-5">
        <StrategyBezel slug={seo.slug} className="mt-1 text-primary" />
        <div className="min-w-0">
          <h1 className={cn(pageTitle, "leading-[1.1]")}>{seo.h1}</h1>
        </div>
        {strategyCapabilityEnabled("compare") ? (
          <Link
            href={`/strategies/compare?ids=${seo.slug}`}
            prefetch={false}
            className={cn(buttonVariants({ variant: "outline", size: "sm" }), "ml-auto shrink-0")}
          >
            Compare
          </Link>
        ) : null}
      </div>
      <p className="relative mt-3 max-w-3xl text-muted-foreground">{seo.dek}</p>
    </section>
  );
}
