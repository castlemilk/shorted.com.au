import { type Post } from "~/@/interfaces/post";
import { calculateReadingTime } from "~/@/utils/reading-time";
import {
  BLOG_CATEGORY_SLUGS,
  type BlogCategory,
  type BlogCategorySlug,
  resolveCategory,
} from "./categories";

/**
 * The slice of a post a listing card needs. Deliberately excludes
 * `content`: the index used to render the newest post's whole MDX body
 * inline, which is what made the page enormous. Cards get an excerpt and
 * a reading time, nothing else.
 */
export interface BlogCard {
  slug: string;
  title: string;
  excerpt: string;
  coverImage: string;
  /** ISO date string as written in frontmatter. */
  date: string;
  author: { name: string; picture: string };
  category: BlogCategory;
  readingMinutes: number;
}

export function toBlogCard(post: Post): BlogCard {
  return {
    slug: post.slug,
    title: post.title,
    excerpt: post.excerpt ?? "",
    coverImage: post.coverImage,
    date: post.date,
    author: {
      name: post.author?.name ?? "Shorted",
      picture: post.author?.picture ?? "",
    },
    category: resolveCategory(post),
    readingMinutes: calculateReadingTime(String(post.content ?? "")),
  };
}

export function blogPostPath(slug: string): string {
  return `/blog/${slug}`;
}

/** "24 Sep 2026" in en-AU; an unparseable date renders as the raw string. */
export function formatBlogDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** Long form for the article header: "24 September 2026". */
export function formatBlogDateLong(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function formatReadingMinutes(minutes: number): string {
  return `${Math.max(1, minutes)} min read`;
}

/**
 * Posts for a "keep reading" rail: same category first, newest first,
 * then the newest of everything else, never the current post.
 */
export function pickRelated(
  cards: BlogCard[],
  currentSlug: string,
  limit = 3,
): BlogCard[] {
  const current = cards.find((c) => c.slug === currentSlug);
  const others = cards.filter((c) => c.slug !== currentSlug);
  if (!current) return others.slice(0, limit);
  const same = others.filter((c) => c.category.slug === current.category.slug);
  const rest = others.filter((c) => c.category.slug !== current.category.slug);
  return [...same, ...rest].slice(0, limit);
}

export type BlogCategoryCounts = Record<"all" | BlogCategorySlug, number>;

/** Post counts per category, plus the total under `all`, for the chip row. */
export function countByCategory(cards: BlogCard[]): BlogCategoryCounts {
  const counts = Object.fromEntries(
    BLOG_CATEGORY_SLUGS.map((slug) => [slug, 0]),
  ) as Record<BlogCategorySlug, number>;
  for (const card of cards) counts[card.category.slug] += 1;
  return { all: cards.length, ...counts };
}
