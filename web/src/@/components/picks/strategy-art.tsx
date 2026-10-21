import { cn } from "~/@/lib/utils";
import { strategyArt } from "~/@/lib/strategies/art";

/**
 * A strategy's editorial art, where it has been generated and baked
 * (lib/strategies/art.ts): the warm-duotone scene the brandbrain flow draws
 * for the strategy's mechanism, in the housing banners' language, so the
 * picker and the housing surfaces read as one brand.
 *
 * Two forms. The BAND sits behind the strategy page's faceplate: a
 * full-bleed scene under a scrim that keeps the H1 and the bezel on paper
 * (or on the CRT), the suburb banner's composition. The PLATE is the hub
 * rack's thumbnail, a 3:2 tile beside the row's glyph. Both are decorative
 * (aria-hidden; the glyph and the name carry the meaning), both fetch ONE
 * file through `.banner-art` (globals.css reads the custom property the
 * active theme selects, so the unreferenced URL is never resolved), and
 * both render nothing for a strategy without art, so a page never carries
 * a broken image or an empty frame.
 *
 * Props-only and server-safe; nothing in the sort island's client graph
 * imports this file.
 */
export function StrategyArtBand({
  slug,
  className,
}: {
  slug: string;
  className?: string;
}) {
  const art = strategyArt(slug);
  if (!art) return null;
  return (
    <div aria-hidden="true" data-strategy-art="band" className={cn("absolute inset-0", className)}>
      <div
        className="banner-art absolute inset-0"
        style={
          {
            "--banner-light": `url('${art.light}')`,
            "--banner-dark": `url('${art.dark}')`,
          } as React.CSSProperties
        }
      />
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
  const art = strategyArt(slug);
  if (!art) return null;
  return (
    <div
      aria-hidden="true"
      data-strategy-art="plate"
      className={cn(
        "banner-art aspect-[3/2] w-full overflow-hidden rounded-sm border border-border/60",
        className,
      )}
      style={
        {
          "--banner-light": `url('${art.light}')`,
          "--banner-dark": `url('${art.dark}')`,
        } as React.CSSProperties
      }
    />
  );
}
