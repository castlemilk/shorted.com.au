import Link from "next/link";
import { ChevronRight } from "lucide-react";

import { getAllPosts } from "~/@/lib/api";
import { toBlogCard } from "~/@/lib/blog/cards";
import { BlogPostGrid } from "~/@/components/blog/blog-post-grid";

// Server-rendered "Latest from the blog" strip for the homepage.
// getAllPosts() is fs-based + date-sorted (newest first), so the freshest
// posts surface here. Renders the top 3 with the same card the /blog index
// uses, so a post looks the same everywhere it is offered.
export function LatestFromBlog() {
  const cards = getAllPosts().slice(0, 3).map(toBlogCard);
  if (cards.length === 0) return null;

  return (
    <section
      aria-labelledby="latest-from-blog-heading"
      className="container mx-auto px-4 py-6"
    >
      <div className="mb-4 flex items-center justify-between">
        <h2
          id="latest-from-blog-heading"
          className="text-lg font-semibold tracking-tight text-foreground"
        >
          Latest from the blog
        </h2>
        <Link
          href="/blog"
          className="group flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-primary"
        >
          View all
          <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </div>

      <BlogPostGrid cards={cards} variant="compact" />
    </section>
  );
}
