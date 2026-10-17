import Image from "next/image";
import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow, sectionTitle } from "~/@/lib/typography";
import {
  type BlogCard,
  blogPostPath,
  formatBlogDate,
  formatReadingMinutes,
} from "~/@/lib/blog/cards";

/**
 * The newest post, given the one hero moment the index allows (DESIGN.md
 * "One Bloom Rule"): a wide two-column card, cover left, serif headline
 * right. Only the excerpt is rendered here. The index used to render this
 * post's entire MDX body inline, which is why the page was enormous.
 *
 * Same one-link-per-card contract as BlogPostCard.
 */
export function BlogFeaturedPost({ card }: { card: BlogCard }) {
  const href = blogPostPath(card.slug);

  return (
    <section aria-labelledby="blog-featured-heading">
      <article className="group relative overflow-hidden rounded-lg border border-primary/30 bg-card transition-[border-color,box-shadow] duration-200 ease-out hover:border-primary/60 hover:shadow-amber-sm focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background motion-reduce:transition-none">
        <div className="grid items-center md:grid-cols-[minmax(0,1.15fr),minmax(0,1fr)]">
          <div className="relative aspect-video w-full overflow-hidden border-b border-border bg-muted md:border-b-0 md:border-r">
            {card.coverImage ? (
              <Image
                src={card.coverImage}
                alt=""
                fill
                // The index's LCP element: eager, with a size hint that stops
                // next/image serving the full-width source to a half-width slot.
                priority
                sizes="(max-width: 768px) 100vw, 60vw"
                className="object-cover"
              />
            ) : null}
          </div>

          <div className="flex flex-col justify-center gap-4 p-6 md:p-8">
            <p
              className={cn(
                eyebrow,
                "flex flex-wrap items-center gap-2 font-medium text-primary",
              )}
            >
              <span>Latest</span>
              <span aria-hidden="true" className="text-muted-foreground">
                /
              </span>
              <span className="text-muted-foreground">
                {card.category.label}
              </span>
            </p>

            {/* One step below the page h1 (pageTitle is text-3xl/4xl): the
                index keeps a single display headline. */}
            <h2
              id="blog-featured-heading"
              className={cn(
                sectionTitle,
                "leading-[1.1] transition-colors group-hover:text-primary md:text-3xl",
              )}
            >
              <Link
                href={href}
                className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
              >
                {card.title}
              </Link>
            </h2>

            {card.excerpt ? (
              <p className="line-clamp-4 font-serif text-base leading-snug text-muted-foreground md:text-lg">
                {card.excerpt}
              </p>
            ) : null}

            <p className="flex flex-wrap gap-x-4 gap-y-2 font-mono text-xs text-muted-foreground">
              <span className="text-foreground/80">{card.author.name}</span>
              <time dateTime={card.date}>{formatBlogDate(card.date)}</time>
              <span className="tabular-nums">
                {formatReadingMinutes(card.readingMinutes)}
              </span>
            </p>
          </div>
        </div>
      </article>
    </section>
  );
}
