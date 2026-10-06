import Image from "next/image";
import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow } from "~/@/lib/typography";
import {
  type BlogCard,
  blogPostPath,
  formatBlogDate,
  formatReadingMinutes,
} from "~/@/lib/blog/cards";

interface BlogPostCardProps {
  card: BlogCard;
  /** `compact` is the homepage strip and the article's "keep reading" rail. */
  variant?: "default" | "compact";
  /** The card is above the fold on its page: load the cover eagerly. */
  priority?: boolean;
  /** Heading level of the title. Cards sit under a section `h2` by default. */
  headingLevel?: "h2" | "h3";
  className?: string;
}

// Cards are 1-up on phones, 2-up on tablets, 3-up from lg on every surface
// that renders them (index grid, category hubs, homepage strip, related rail).
const COVER_SIZES = "(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw";

/**
 * One blog post as a distinct card: cover on top, mono meta row, mono
 * headline, clamped excerpt, byline. Flat at rest (a hairline border on the
 * card surface), amber on hover, per DESIGN.md §4.
 *
 * ONE link per card. The title's `after:` pseudo-element stretches over the
 * whole card so the entire surface is clickable without nesting anchors
 * (nested interactive content is invalid HTML and a screen-reader trap), and
 * crawlers see each post linked once from the grid rather than three times.
 * Focus lands on that link; the ring is drawn on the card via focus-within.
 */
export function BlogPostCard({
  card,
  variant = "default",
  priority = false,
  headingLevel = "h3",
  className,
}: BlogPostCardProps) {
  const compact = variant === "compact";
  const Heading = headingLevel;
  const href = blogPostPath(card.slug);
  const thumbnail = card.thumbnailImage?.trim()
    ? card.thumbnailImage.trim()
    : card.coverImage;

  return (
    <article
      className={cn(
        "group relative flex h-full flex-col overflow-hidden rounded-lg border border-border bg-card",
        "transition-[border-color,box-shadow] duration-200 ease-out hover:border-primary/40 hover:shadow-amber-sm",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2 focus-within:ring-offset-background",
        "motion-reduce:transition-none",
        className,
      )}
    >
      {/* One 16:9 crop from article masthead to the smallest related card.
          Topic illustrations keep their subject in the central safe area. */}
      <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
        {thumbnail ? (
          <Image
            src={thumbnail}
            alt=""
            fill
            priority={priority}
            sizes={COVER_SIZES}
            className="object-cover"
          />
        ) : null}
      </div>

      <div
        className={cn(
          "flex flex-1 flex-col",
          compact ? "gap-2 p-4" : "gap-3 p-5",
        )}
      >
        <div className={cn(eyebrow, "flex items-center justify-between gap-3")}>
          <span className="font-medium text-primary">
            {card.category.label}
          </span>
          <span className="whitespace-nowrap tabular-nums">
            {formatReadingMinutes(card.readingMinutes)}
          </span>
        </div>

        {/* Cards are navigation, so both variants stay mono. Newsreader
            arrives at the featured story and the article's own masthead. */}
        <Heading
          className={cn(
            "font-mono font-semibold leading-snug text-foreground transition-colors group-hover:text-primary",
            compact
              ? "line-clamp-2 text-sm"
              : "line-clamp-3 text-lg tracking-tight",
          )}
        >
          <Link
            href={href}
            className="after:absolute after:inset-0 after:content-[''] focus-visible:outline-none"
          >
            {card.title}
          </Link>
        </Heading>

        {card.excerpt ? (
          <p
            className={cn(
              "text-sm leading-relaxed text-muted-foreground",
              compact ? "line-clamp-2" : "line-clamp-3",
            )}
          >
            {card.excerpt}
          </p>
        ) : null}

        <div className="mt-auto flex items-center gap-2 border-t border-border/60 pt-3 font-mono text-xs text-muted-foreground">
          {card.author.picture ? (
            <Image
              src={card.author.picture}
              alt=""
              width={20}
              height={20}
              className="h-5 w-5 shrink-0 rounded-full object-cover"
            />
          ) : null}
          <span className="truncate text-foreground/80">
            {card.author.name}
          </span>
          <span aria-hidden="true">·</span>
          <time dateTime={card.date} className="whitespace-nowrap tabular-nums">
            {formatBlogDate(card.date)}
          </time>
        </div>
      </div>
    </article>
  );
}
