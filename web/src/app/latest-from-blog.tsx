import Link from "next/link";
import Image from "next/image";
import { ChevronRight } from "lucide-react";
import { getAllPosts } from "~/@/lib/api";

// Server-rendered "Latest from the blog" strip for the homepage.
// getAllPosts() is fs-based + date-sorted (newest first), so the freshest
// posts surface here. Renders the top 3 as cards linking to /blog/[slug].
export function LatestFromBlog() {
  const posts = getAllPosts().slice(0, 3);
  if (posts.length === 0) return null;

  return (
    <section className="container mx-auto px-4 py-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">
          Latest from the blog
        </h2>
        <Link
          href="/blog"
          className="group flex items-center gap-1 text-sm text-muted-foreground hover:text-primary transition-colors"
        >
          View all
          <ChevronRight className="h-4 w-4 group-hover:translate-x-0.5 transition-transform" />
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {posts.map((post) => (
          <Link
            key={post.slug}
            href={`/blog/${post.slug}`}
            className="group flex flex-col overflow-hidden rounded-lg border border-border bg-card hover:border-primary/40 transition-colors"
          >
            {post.coverImage && (
              <div className="relative aspect-[16/9] w-full overflow-hidden bg-muted">
                <Image
                  src={post.coverImage}
                  alt={post.title}
                  fill
                  sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                  className="object-cover group-hover:scale-[1.02] transition-transform duration-300"
                />
              </div>
            )}
            <div className="flex flex-1 flex-col p-4">
              <h3 className="text-sm font-semibold leading-snug text-foreground group-hover:text-primary transition-colors line-clamp-2">
                {post.title}
              </h3>
              {post.excerpt && (
                <p className="mt-2 text-xs text-muted-foreground line-clamp-2">
                  {post.excerpt}
                </p>
              )}
              {post.date && (
                <time
                  dateTime={post.date}
                  className="mt-3 text-[11px] uppercase tracking-wider text-muted-foreground/70"
                >
                  {new Date(post.date).toLocaleDateString("en-AU", {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </time>
              )}
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}
