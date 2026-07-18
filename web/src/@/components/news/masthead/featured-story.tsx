import Link from "next/link";
import type { FeaturedItem } from "./featured";

/**
 * FeaturedStory — a pinned, clearly-labelled "Featured investigation" card for
 * the /news masthead. Links out to a bespoke `/features/*` page. The visual
 * layers the page's OG art over an amber bloom so it degrades gracefully if the
 * image route is unavailable (background-image, not <img>, so no broken icon).
 */
/**
 * Route a same-origin image (e.g. the /features OG route, ~97KB PNG) through
 * the Next.js image optimizer so the card ships a resized AVIF/WebP instead.
 * Kept as a CSS background (see component docstring), so we build the
 * /_next/image URL by hand. External URLs pass through untouched — the
 * optimizer 400s on hosts outside remotePatterns.
 */
function optimizedBackgroundUrl(image: string): string {
  if (!image.startsWith("/")) return image;
  return `/_next/image?url=${encodeURIComponent(image)}&w=828&q=70`;
}

export function FeaturedStory({ item }: { item: FeaturedItem }) {
  return (
    <section aria-label="Featured investigation">
      <Link
        href={item.href}
        className="group block overflow-hidden rounded-xl border border-primary/30 bg-card shadow-amber-sm transition-colors hover:border-primary/60"
      >
        <div className="grid md:grid-cols-2">
          {/* visual */}
          <div className="relative aspect-[16/9] overflow-hidden bg-gradient-to-br from-orange-950/50 via-zinc-950 to-zinc-950 md:aspect-auto md:min-h-[240px]">
            <div
              aria-hidden
              className="absolute inset-0"
              style={{
                backgroundImage:
                  "radial-gradient(circle at 30% 30%, rgba(255,169,77,0.2), transparent 60%)",
              }}
            />
            {item.image ? (
              <div
                aria-hidden
                className="absolute inset-0 bg-cover bg-center opacity-95 transition-transform duration-700 group-hover:scale-[1.02]"
                style={{ backgroundImage: `url('${optimizedBackgroundUrl(item.image)}')` }}
              />
            ) : null}
          </div>

          {/* content */}
          <div className="flex flex-col justify-center gap-3 p-6 md:p-8">
            <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-primary">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-primary" />
              {item.kicker}
            </p>

            <h2 className="font-serif text-3xl font-semibold leading-[1.05] tracking-tight transition-colors group-hover:text-primary md:text-4xl">
              {item.headline}
            </h2>

            {item.standfirst ? (
              <p className="font-serif text-base leading-snug text-muted-foreground md:text-lg">
                {item.standfirst}
              </p>
            ) : null}

            {item.meta?.length ? (
              <p className="font-mono text-[11px] text-muted-foreground">
                {item.meta.join("  ·  ")}
              </p>
            ) : null}

            <span className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-primary">
              Read the investigation
              <span aria-hidden className="transition-transform group-hover:translate-x-0.5">
                →
              </span>
            </span>
          </div>
        </div>
      </Link>
    </section>
  );
}
