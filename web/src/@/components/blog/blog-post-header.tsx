import Image from "next/image";
import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow, lede, pageTitle } from "~/@/lib/typography";
import {
  type BlogCard,
  formatBlogDateLong,
  formatReadingMinutes,
} from "~/@/lib/blog/cards";

interface BlogPostHeaderProps {
  card: BlogCard;
  /** ISO date of the last substantive revision, when the post declares one. */
  updated?: string;
  /** Author profile route (`/authors/[slug]`); omitted when the byline has no profile. */
  authorHref?: string;
}

/**
 * Article masthead: category eyebrow, serif title, standfirst, byline rule,
 * cover. The standfirst carries `.article-summary` because ArticleSchema's
 * speakable selector names it.
 */
export function BlogPostHeader({
  card,
  updated,
  authorHref,
}: BlogPostHeaderProps) {
  const summary = card.standfirst?.trim() ? card.standfirst : card.excerpt;
  const byline = (
    <>
      {card.author.picture ? (
        <Image
          src={card.author.picture}
          alt=""
          width={28}
          height={28}
          className="h-7 w-7 shrink-0 rounded-full object-cover"
        />
      ) : null}
      <span className="font-medium text-foreground">{card.author.name}</span>
    </>
  );

  return (
    <header className="mx-auto max-w-[54rem]">
      {/* Plain text on purpose: the breadcrumb directly above already links
          the category hub, and a bare text-xs link would be a 16px target. */}
      <p className={cn(eyebrow, "mb-3 font-medium text-primary")}>
        {card.category.label}
      </p>

      <h1 className={cn(pageTitle, "leading-[1.08] md:text-5xl")}>
        {card.title}
      </h1>

      {summary ? (
        <p className={cn(lede, "article-summary mt-5 font-serif text-xl leading-relaxed md:text-2xl")}>
          {summary}
        </p>
      ) : null}

      <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3 border-y border-border py-4 font-mono text-xs text-muted-foreground">
        {authorHref ? (
          <Link
            href={authorHref}
            rel="author"
            className="flex min-h-7 items-center gap-2 rounded-sm transition-colors hover:text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
          >
            {byline}
          </Link>
        ) : (
          <span className="flex items-center gap-2">{byline}</span>
        )}
        <time dateTime={card.date}>{formatBlogDateLong(card.date)}</time>
        <span className="tabular-nums">
          {formatReadingMinutes(card.readingMinutes)}
        </span>
        {updated ? (
          <span className="tabular-nums">
            Updated{" "}
            <time dateTime={updated}>{formatBlogDateLong(updated)}</time>
          </span>
        ) : null}
      </div>

      {card.coverImage ? (
        <figure className="relative mt-8 aspect-video overflow-hidden rounded-lg border border-border bg-muted">
          <Image
            src={card.coverImage}
            // Content, not decoration: this file is also the og:image and
            // the BlogPosting image, so it carries a real description.
            alt={card.coverAlt?.trim() ? card.coverAlt : `Cover illustration for ${card.title}`}
            fill
            // The article's LCP element.
            priority
            sizes="(max-width: 864px) 100vw, 864px"
            className="object-cover"
          />
        </figure>
      ) : null}
    </header>
  );
}
