import { cn } from "~/@/lib/utils";
import { strategyArt } from "~/@/lib/strategies/art";
import { hasScene } from "~/@/lib/strategies/scenes";
import { StrategyScene } from "./strategy-scene";

/**
 * A strategy's art, in two forms. The BAND sits behind the strategy page's
 * faceplate under a scrim that keeps the H1 and the bezel on paper (or on
 * the CRT), the suburb banner's composition. The PLATE is the hub rack's
 * tile, 3:2, beside the row's glyph.
 *
 * What fills them: the strategy's generative scene (lib/strategies/scenes.ts,
 * drawn from its mechanism, animated in the browser) by default, or, where
 * the owner has generated and baked editorial art through the brandbrain
 * flow (lib/strategies/art.ts), that scene as a light/dark AVIF pair fetched
 * once through `.banner-art`. Both are decorative (aria-hidden; the glyph
 * and the name carry the meaning), and a strategy with neither renders
 * nothing, so a page never carries a broken image or an empty frame.
 *
 * Props-only and server-safe; the only client code is the scene's canvas,
 * loaded lazily by the scene itself.
 */

/** Whether a strategy has any art to show: baked, or a scene. */
export function hasStrategyArt(slug: string): boolean {
  return strategyArt(slug) !== null || hasScene(slug);
}

function BakedArt({ slug, className }: { slug: string; className?: string }) {
  const art = strategyArt(slug)!;
  return (
    <div
      className={cn("banner-art", className)}
      style={
        {
          "--banner-light": `url('${art.light}')`,
          "--banner-dark": `url('${art.dark}')`,
        } as React.CSSProperties
      }
    />
  );
}

export function StrategyArtBand({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  const baked = strategyArt(slug) !== null;
  if (!baked && !hasScene(slug)) return null;
  return (
    <div
      aria-hidden="true"
      data-strategy-art={baked ? "band" : "scene"}
      className={cn("absolute inset-0", className)}
    >
      {baked ? (
        <BakedArt slug={slug} className="absolute inset-0" />
      ) : (
        <StrategyScene slug={slug} variant="band" className="absolute inset-0" />
      )}
      {/* The scrim: the page surface fading out to the right, so the
          faceplate sits on paper and the scene shows where there is no
          text. The second fade keeps the provenance plate legible. */}
      <div className="absolute inset-0 bg-gradient-to-r from-background/95 via-background/80 to-background/30" />
      <div className="absolute inset-0 bg-gradient-to-t from-background/70 to-transparent" />
    </div>
  );
}

export function StrategyArtPlate({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  const baked = strategyArt(slug) !== null;
  if (!baked && !hasScene(slug)) return null;
  const frame = cn(
    "relative aspect-[3/2] w-full overflow-hidden rounded-sm border border-border/60 bg-background",
    className,
  );
  if (baked) {
    return (
      <div aria-hidden="true" data-strategy-art="plate">
        <BakedArt slug={slug} className={frame} />
      </div>
    );
  }
  return (
    <div aria-hidden="true" data-strategy-art="plate-scene" className={frame}>
      <StrategyScene slug={slug} variant="plate" className="absolute inset-0 h-full w-full" />
    </div>
  );
}
