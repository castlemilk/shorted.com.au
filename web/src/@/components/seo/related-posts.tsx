import { sectionTitle } from "~/@/lib/typography";
import { getAllPosts } from "~/@/lib/api";
import { pickRelated, toBlogCard } from "~/@/lib/blog/cards";
import { BlogPostGrid } from "~/@/components/blog/blog-post-grid";

interface RelatedPostsProps {
  currentSlug: string;
  maxPosts?: number;
}

/**
 * "Keep reading" rail under an article: same category first, then the
 * newest of everything else, never the article itself.
 */
export function RelatedPosts({ currentSlug, maxPosts = 3 }: RelatedPostsProps) {
  const related = pickRelated(
    getAllPosts().map(toBlogCard),
    currentSlug,
    maxPosts,
  );

  if (related.length === 0) {
    return null;
  }

  return (
    <section
      aria-labelledby="related-posts-heading"
      className="mt-16 border-t border-border pt-8"
    >
      <h2 id="related-posts-heading" className={sectionTitle}>
        Keep reading
      </h2>
      <BlogPostGrid cards={related} variant="compact" className="mt-6" />
    </section>
  );
}
