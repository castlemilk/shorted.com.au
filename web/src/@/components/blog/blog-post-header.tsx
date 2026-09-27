import Image from "next/image";
import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle } from "~/@/lib/typography";
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
    <header className="mx-auto max-w-3xl">
      {/* Plain text on purpose: the breadcrumb directly above already links
          the category hub, and a bare text-xs link would be a 16px target. */}
      <p className={cn(eyebrow, "mb-3 font-medium text-primary")}>
        {card.category.label}
      </p>

      <h1 className={cn(pageTitle, "leading-[1.08] md:text-5xl")}>
        {card.title}
      </h1>

      {card.excerpt ? (
        <p className="article-summary mt-4 font-serif text-lg leading-snug text-muted-foreground md:text-xl">
          {card.excerpt}
        </p>
      ) : null}

      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2 border-y border-border py-3 font-mono text-xs text-muted-foreground">
        {authorHref ? (
          <Link
            href={authorHref}
            rel="author"
            className="flex items-center gap-2 transition-colors hover:text-primary"
          >
            {byline}
          </Link>
        ) : (
          <span className="flex items-center gap-2">{byline}</span>
        )}
        <time dateTime={card.date}>{formatBlogDateLong(card.date)}</time>
        <span aria-hidden="true">·</span>
        <span className="tabular-nums">
          {formatReadingMinutes(card.readingMinutes)}
        </span>
        {updated ? (
          <>
            <span aria-hidden="true">·</span>
            <span>
              Updated{" "}
              <time dateTime={updated}>{formatBlogDateLong(updated)}</time>
            </span>
          </>
        ) : null}
      </div>

      {card.coverImage ? (
        <figure className="relative mt-8 aspect-[3/2] overflow-hidden rounded-lg border border-border bg-muted md:aspect-[2/1]">
          <Image
            src={card.coverImage}
            // Content, not decoration: this file is also the og:image and
            // the BlogPosting image, so it carries a real description.
            alt={`Cover illustration for ${card.title}`}
            fill
            // The article's LCP element.
            priority
            sizes="(max-width: 768px) 100vw, 768px"
            className="object-cover"
          />
        </figure>
      ) : null}
    </header>
  );
}
