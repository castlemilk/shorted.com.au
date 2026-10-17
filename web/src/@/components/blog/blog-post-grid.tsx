import { cn } from "~/@/lib/utils";
import { type BlogCard } from "~/@/lib/blog/cards";
import { BlogPostCard } from "./blog-post-card";

interface BlogPostGridProps {
  cards: BlogCard[];
  /** Card variant; `compact` for the homepage strip and the article rail. */
  variant?: "default" | "compact";
  /**
   * Heading level of every card title. `h3` when the grid sits under a
   * section h2 (the index, the homepage strip, the article rail); `h2` when
   * the grid follows the page h1 directly (a category hub), so the outline
   * never skips a level.
   */
  headingLevel?: "h2" | "h3";
  /** How many leading cards are above the fold and load their cover eagerly. */
  priorityCount?: number;
  className?: string;
}

/**
 * The one grid every blog-card surface renders through: 1-up on phones,
 * 2-up on tablets, 3-up from lg. BlogPostCard's cover `sizes` hint assumes
 * exactly this shape, so surfaces must not hand-roll their own columns.
 */
export function BlogPostGrid({
  cards,
  variant = "default",
  headingLevel = "h3",
  priorityCount = 0,
  className,
}: BlogPostGridProps) {
  if (cards.length === 0) return null;
  return (
    <ul
      className={cn(
        "grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
        variant === "compact" ? "gap-4" : "gap-5",
        className,
      )}
    >
      {cards.map((card, index) => (
        <li key={card.slug} className="flex">
          <BlogPostCard
            card={card}
            variant={variant}
            headingLevel={headingLevel}
            priority={index < priorityCount}
          />
        </li>
      ))}
    </ul>
  );
}
