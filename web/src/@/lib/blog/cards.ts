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
  standfirst?: string;
  coverImage: string;
  thumbnailImage?: string;
  coverAlt?: string;
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
    standfirst: post.standfirst,
    coverImage: post.coverImage,
    thumbnailImage: post.thumbnailImage,
    coverAlt: post.coverAlt,
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

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A frontmatter date is either a calendar day ("2026-09-24"), which must
 * render as that day whatever the server's clock says, or a timestamp,
 * which names an instant and is shown on the calendar Australian readers
 * live by (so "2026-10-01T09:00:00+10:00" is 1 Oct, not 30 Sep).
 */
function displayDate(iso: string): { date: Date; timeZone: string } | null {
  const day = DATE_ONLY.exec(iso);
  if (day) {
    return {
      date: new Date(Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!)),
      timeZone: "UTC",
    };
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return { date, timeZone: "Australia/Sydney" };
}

/** "24 Sep 2026" in en-AU; an unparseable date renders as the raw string. */
export function formatBlogDate(iso: string): string {
  const d = displayDate(iso);
  if (!d) return iso;
  return d.date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: d.timeZone,
  });
}

/** Long form for the article header: "24 September 2026". */
export function formatBlogDateLong(iso: string): string {
  const d = displayDate(iso);
  if (!d) return iso;
  return d.date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: d.timeZone,
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
