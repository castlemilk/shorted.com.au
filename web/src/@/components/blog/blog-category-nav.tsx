import Link from "next/link";

import { cn } from "~/@/lib/utils";
import { eyebrow } from "~/@/lib/typography";
import {
  BLOG_CATEGORIES,
  type BlogCategorySlug,
  blogCategoryPath,
} from "~/@/lib/blog/categories";
import { type BlogCategoryCounts } from "~/@/lib/blog/cards";

interface BlogCategoryNavProps {
  active: "all" | BlogCategorySlug;
  counts: BlogCategoryCounts;
  className?: string;
}

/**
 * Category chips. Plain links to the static hub routes rather than a client
 * filter: each category is then a crawlable page with its own title and
 * description, and the index stays a zero-JS ISR page. (Reading
 * `searchParams` for a `?category=` filter would silently force dynamic
 * rendering and throw the ISR away — see the housing landmine in CLAUDE.md.)
 *
 * Empty categories are not offered; the hub route still exists for them.
 */
export function BlogCategoryNav({
  active,
  counts,
  className,
}: BlogCategoryNavProps) {
  const items = [
    { slug: "all" as const, label: "All", href: "/blog", count: counts.all },
    ...BLOG_CATEGORIES.filter((c) => (counts[c.slug] ?? 0) > 0).map((c) => ({
      slug: c.slug,
      label: c.label,
      href: blogCategoryPath(c.slug),
      count: counts[c.slug] ?? 0,
    })),
  ];

  return (
    <nav aria-label="Blog categories" className={className}>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => {
          const isActive = item.slug === active;
          return (
            <li key={item.slug}>
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                aria-label={`${item.label}, ${item.count} ${item.count === 1 ? "article" : "articles"}`}
                className={cn(
                  eyebrow,
                  "inline-flex h-9 items-center gap-2 rounded-md border px-3 transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                  isActive
                    ? "border-primary bg-primary font-medium text-primary-foreground"
                    : "border-border bg-card hover:border-primary/40 hover:text-foreground",
                )}
              >
                {item.label}
                {/* Full-strength token colour: an alpha-faded count fell to
                    3.0:1 on paper, under AA for 12px text. Weight carries the
                    hierarchy instead. */}
                <span aria-hidden="true" className="font-normal tabular-nums">
                  {item.count}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
