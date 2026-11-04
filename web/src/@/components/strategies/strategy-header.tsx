import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle } from "~/@/lib/typography";
import { getStrategy } from "~/@/lib/strategies/registry";
import {
  StrategyArtBand,
  hasStrategyArt,
} from "~/@/components/picks/strategy-art";
import { StrategyBezel } from "~/@/components/picks/strategy-glyph";

/**
 * The strategy profile's faceplate: the glyph in its bezel beside the serif H1
 * and the dek, on the strategy's art when it has any. It is the stage the
 * scene's pointer reads (data-scene-stage), so a pointer over the H1 plays it.
 *
 * Server-rendered from the registry alone: the name, the dek and the art are
 * static, so the layout that renders it reads nothing and cannot fail a render.
 * The author, the provenance and the rest of the data belong to the Overview.
 *
 * Action buttons (Compare, Create alert) are not rendered here: each one arrives
 * with the capability it needs (lib/strategies/capabilities.ts), and none is on.
 */
export function StrategyHeader({ slug }: { slug: string }) {
  const seo = getStrategy(slug);
  if (!seo) return null;
  const hasArt = hasStrategyArt(seo.slug);

  return (
    <section
      data-scene-stage={hasArt ? "" : undefined}
      className={cn(
        "motion-safe:animate-phosphor-warm",
        hasArt
          ? "relative overflow-hidden rounded-lg border border-border/60 p-4 sm:p-6"
          : "border-b border-border/40 pb-6",
      )}
    >
      <StrategyArtBand slug={seo.slug} />
      <div className="relative flex items-start gap-4 sm:gap-5">
        <StrategyBezel slug={seo.slug} className="mt-1 text-primary" />
        <div className="min-w-0">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            <Link href="/strategies" className="hover:text-foreground">
              Stock picker
            </Link>
          </p>
          <h1 className={cn(pageTitle, "leading-[1.1]")}>{seo.h1}</h1>
        </div>
      </div>
      <p className="relative mt-3 max-w-3xl text-muted-foreground">{seo.dek}</p>
    </section>
  );
}
