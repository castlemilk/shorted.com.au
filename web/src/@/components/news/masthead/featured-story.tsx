import Link from "next/link";
import { preload } from "react-dom";
import { cn } from "~/@/lib/utils";
import { eyebrow, sectionTitle } from "~/@/lib/typography";
import type { FeaturedItem } from "./featured";

/**
 * FeaturedStory — a pinned, clearly-labelled "Featured investigation" card for
 * the /news masthead. Links out to a bespoke `/features/*` page. Dedicated
 * artwork fills a static 16:9 frame; legacy typed OG cards are contained.
 */
/**
 * Route a same-origin image (e.g. the /features OG route, ~97KB PNG) through
 * the Next.js image optimizer so the card ships a resized AVIF/WebP instead.
 * We build the /_next/image URL by hand. External URLs pass through untouched — the
 * optimizer 400s on hosts outside remotePatterns.
 */
function optimizedBackgroundUrl(image: string): string {
  if (!image.startsWith("/")) return image;
  return `/_next/image?url=${encodeURIComponent(image)}&w=828&q=70`;
}

export function FeaturedStory({
  item,
  priority = false,
}: {
  item: FeaturedItem;
  /** Set on pages where this card is the LCP element (/news masthead): emit a
   *  <link rel="preload" as="image"> for the optimized URL. Leave off where
   *  the card is below the fold (homepage). */
  priority?: boolean;
}) {
  if (priority && item.image) {
    preload(optimizedBackgroundUrl(item.image), { as: "image" });
  }
  return (
    <section aria-label="Featured investigation">
      <Link
        href={item.href}
        className="group block overflow-hidden rounded-lg border border-primary/30 bg-card transition-colors hover:border-primary/60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring motion-reduce:transition-none"
      >
        <div className="grid items-center md:grid-cols-2">
          {/* visual */}
          <div className="relative aspect-video w-full overflow-hidden border-b border-border bg-muted md:border-b-0 md:border-r">
            {item.image ? (
              // Real <img> (not CSS background): the preload scanner and
              // Lighthouse's LCP model both discover it from the HTML, and a
              // decorative empty alt means a failed load renders blank — same
              // graceful degradation as the old background-image approach.
              // eslint-disable-next-line @next/next/no-img-element -- The src already uses the image optimizer.
              <img
                aria-hidden
                alt=""
                src={optimizedBackgroundUrl(item.image)}
                // React 18 forwards the lowercase HTML attribute without an
                // unknown-prop warning; the browser still honours its priority.
                {...{ fetchpriority: priority ? "high" : "auto" }}
                loading={priority ? "eager" : "lazy"}
                decoding="async"
                className={cn("absolute inset-0 h-full w-full object-center", item.image.includes("/opengraph-image") ? "object-contain" : "object-cover")}
              />
            ) : null}
          </div>

          {/* content */}
          <div className="flex flex-col justify-center gap-3 p-6 md:p-8">
            <p className={cn(eyebrow, "font-medium text-primary")}>
              {item.kicker}
            </p>

            <h2 className={cn(sectionTitle, "text-3xl leading-[1.08] transition-colors group-hover:text-primary md:text-4xl")}>
              {item.headline}
            </h2>

            {item.standfirst ? (
              <p className="font-serif text-base leading-snug text-muted-foreground md:text-lg">
                {item.standfirst}
              </p>
            ) : null}

            {item.meta?.length ? (
              <p className="flex flex-wrap gap-x-4 gap-y-2 font-mono text-xs tabular-nums text-muted-foreground">
                {item.meta.map((text, index) => <span key={`${index}-${text}`}>{text}</span>)}
              </p>
            ) : null}

          </div>
        </div>
      </Link>
    </section>
  );
}
