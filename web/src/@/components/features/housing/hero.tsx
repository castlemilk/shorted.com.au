import { StatStrip } from "./stat-strip";
import { HERO_STATS } from "./data/stats";

/**
 * Full-bleed masthead for the feature. Terminal-black canvas, an amber radial
 * glow and a faint grid, Newsreader display title, serif standfirst, byline and
 * the opening stat strip. Static — entrance handled by CSS, no client JS.
 */
export function Hero() {
  return (
    <header className="relative overflow-hidden border-b border-border bg-background">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        {/* amber bloom */}
        <div className="absolute -top-1/3 left-1/2 h-[55rem] w-[55rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,hsl(32_100%_65%/0.13),transparent)]" />
        {/* faint grid */}
        <div
          className="absolute inset-0 opacity-[0.18]"
          style={{
            backgroundImage:
              "linear-gradient(to right, hsl(var(--border) / 0.6) 1px, transparent 1px), linear-gradient(to bottom, hsl(var(--border) / 0.6) 1px, transparent 1px)",
            backgroundSize: "52px 52px",
            maskImage: "radial-gradient(ellipse at 50% 30%, black, transparent 75%)",
            WebkitMaskImage: "radial-gradient(ellipse at 50% 30%, black, transparent 75%)",
          }}
        />
      </div>

      <div className="relative mx-auto max-w-3xl px-5 py-20 sm:px-6 sm:py-28">
        <div className="animate-fade-in font-mono text-xs uppercase tracking-[0.3em] text-primary">
          Shorted &middot; Investigation
        </div>

        <h1 className="animate-fade-in mt-6 font-serif text-5xl font-medium leading-[0.95] text-foreground sm:text-7xl">
          The Widow-Maker
        </h1>

        <p className="animate-fade-in-delay mt-6 max-w-2xl font-serif text-xl leading-relaxed text-muted-foreground sm:text-2xl">
          You can&rsquo;t short a house &mdash; so the bears short the banks that
          wrote the mortgage. For a decade it has been a graveyard. This is the
          machine that keeps Australian house prices climbing &mdash; negative
          gearing, a 1999 tax switch, and the buying power of four banks &mdash;
          and what Japan, China and America reveal about the day it finally jams.
        </p>

        <div className="animate-fade-in-delay mt-7 flex flex-wrap items-center gap-3 font-mono text-[0.7rem] uppercase tracking-[0.2em] text-muted-foreground">
          <span className="text-foreground/80">The Shorted Desk</span>
          <span className="text-border">/</span>
          <span>Markets &amp; Macro</span>
          <span className="text-border">/</span>
          <span>23 June 2026</span>
        </div>

        <div className="mt-12">
          <StatStrip stats={HERO_STATS} />
        </div>
      </div>
    </header>
  );
}
