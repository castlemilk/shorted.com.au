/**
 * Blog categories: the four shelves every `_blogs/*.mdx` post sits on.
 *
 * A post declares its shelf in frontmatter (`category: guides`). The
 * registry is the single source of truth for the label, the category hub
 * route (`/blog/category/[slug]`) and the copy that hub carries, so the
 * index chips, the post eyebrow, the JSON-LD `articleSection` and the
 * sitemap all agree without restating the list.
 *
 * `resolveCategory` never throws: a post with a missing or unknown category
 * falls back to a slug heuristic so the page still renders, and
 * `categories.test.ts` is what flags the frontmatter for fixing.
 */

export type BlogCategorySlug = "guides" | "analysis" | "housing" | "product";

export interface BlogCategory {
  slug: BlogCategorySlug;
  /** Short chip / eyebrow label. */
  label: string;
  /** Page `<h1>` on the category hub. */
  title: string;
  /** Lede under the hub title; doubles as the hub's meta description. */
  description: string;
}

export const BLOG_CATEGORIES: readonly BlogCategory[] = [
  {
    slug: "guides",
    label: "Guides",
    title: "Short Selling Guides",
    description:
      "How short selling works in Australia: reading ASIC's daily reports, the metrics that matter, what a short position costs to hold, and how squeezes and activist campaigns actually play out.",
  },
  {
    slug: "analysis",
    label: "Market analysis",
    title: "ASX Short Interest Analysis",
    description:
      "Data stories from the ASIC short-position feed: the most shorted stocks, sector rotations, squeeze candidates and what crowded bear positioning revealed before the news caught up.",
  },
  {
    slug: "housing",
    label: "Housing",
    title: "Australian Housing Data",
    description:
      "State-by-state house prices, how to read a suburb profile, and where asking prices are being cut, built from ABS, RBA, Valuer-General data and Shorted's own listings crawl.",
  },
  {
    slug: "product",
    label: "Product",
    title: "Product Updates",
    description:
      "What is new on Shorted: dashboard releases, AI-generated reports, and the MCP server that lets Claude and ChatGPT read the data directly.",
  },
] as const;

export const BLOG_CATEGORY_SLUGS: readonly BlogCategorySlug[] =
  BLOG_CATEGORIES.map((c) => c.slug);

const BY_SLUG: ReadonlyMap<string, BlogCategory> = new Map(
  BLOG_CATEGORIES.map((c) => [c.slug, c]),
);

export function isBlogCategorySlug(value: unknown): value is BlogCategorySlug {
  return typeof value === "string" && BY_SLUG.has(value);
}

export function getBlogCategory(slug: string): BlogCategory | undefined {
  return BY_SLUG.get(slug);
}

export function blogCategoryPath(slug: BlogCategorySlug): string {
  return `/blog/category/${slug}`;
}

/**
 * Safety net for posts published without a `category` in frontmatter.
 * Ordered most-specific first; anything unmatched is a guide, which is
 * what most of the back catalogue is.
 */
const HEURISTICS: ReadonlyArray<{ test: RegExp; slug: BlogCategorySlug }> = [
  {
    test: /hous|suburb|listing|asking-price|price-drop|property|rent/i,
    slug: "housing",
  },
  {
    test: /^shorted-|platform|mcp|release|hello-world|introducing|update/i,
    slug: "product",
  },
  {
    // Explainers: "how to", "explained", "what is", comparisons, the
    // sector primer. Checked before analysis so a guide about the most
    // shorted sectors is not filed as a data story.
    test: /how-to|guide|explained|what-|cost-|days-to-cover|-vs-|sectors/i,
    slug: "guides",
  },
  {
    test: /most-shorted|candidates|hormuz|oil|iran|rotation|deep-dive/i,
    slug: "analysis",
  },
];

/**
 * The category a post belongs to. Frontmatter wins; a missing or unknown
 * value falls through to the slug heuristics above.
 */
export function resolveCategory(post: {
  slug: string;
  category?: string;
}): BlogCategory {
  const declared = post.category ? BY_SLUG.get(post.category) : undefined;
  if (declared) return declared;
  const guess =
    HEURISTICS.find((h) => h.test.test(post.slug))?.slug ?? "guides";
  return BY_SLUG.get(guess)!;
}
