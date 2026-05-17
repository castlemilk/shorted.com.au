/**
 * Author profiles for E-E-A-T signalling.
 *
 * Each author is rendered as a `Person` schema with sameAs links
 * to their public profiles (LinkedIn, Twitter/X, GitHub). Per
 * Google's Sept 2025 Quality Rater Guidelines update, the
 * "Author" signal is mandatory for finance YMYL content.
 *
 * To add an author:
 * 1. Append a new entry to AUTHORS below
 * 2. Reference the slug from blog posts / reports / etc via
 *    the `author` field
 * 3. (Optional) drop a photo at `/public/authors/[slug].jpg`
 *
 * Slugs must be URL-safe — they're used as path segments.
 */

export interface Author {
  slug: string;
  name: string;
  /** Public-facing title (e.g. "Founder & Editor", "Data Lead") */
  title: string;
  /** 1-2 paragraph bio rendered on the author page. Markdown not supported — plain text. */
  bio: string;
  /** Optional photo URL — defaults to a generic avatar if missing. */
  photoUrl?: string;
  /** External profiles for Person.sameAs Knowledge Graph anchors. */
  sameAs?: {
    linkedin?: string;
    twitter?: string;
    github?: string;
    website?: string;
    googleScholar?: string;
  };
  /** Areas of editorial focus / expertise */
  expertise?: string[];
  /** Qualifications, prior roles, credentials */
  credentials?: string[];
  /** Optional email shown on the profile page */
  email?: string;
}

export const AUTHORS: Author[] = [
  // ============================================================
  // PLACEHOLDER — replace this entry with your real author profile.
  // To remove the placeholder banner on the live page, set
  // `placeholder` to false on the editorial entry below.
  // ============================================================
  {
    slug: "shorted-editorial",
    name: "Shorted Editorial",
    title: "Editorial Team",
    bio: "The Shorted editorial team monitors ASIC short position reports daily and surfaces the most actionable signals for Australian investors. We aggregate official short data from ASIC, market data from the ASX, and director-trade filings to build a complete picture of short-selling activity in the Australian market. All analysis is sourced from primary regulatory filings.",
    expertise: [
      "ASX short selling",
      "ASIC reporting frameworks",
      "Australian equity markets",
    ],
    credentials: [
      "Data sourced directly from ASIC RG 196 publications",
      "Independent — no broker relationships or paid coverage",
    ],
    sameAs: {
      twitter: "https://twitter.com/shorted",
    },
  },
];

export function getAuthorBySlug(slug: string): Author | undefined {
  return AUTHORS.find((a) => a.slug === slug);
}

export function getAllAuthorSlugs(): string[] {
  return AUTHORS.map((a) => a.slug);
}

/** Default author slug used when a post/report has no explicit author. */
export const DEFAULT_AUTHOR_SLUG = "shorted-editorial";
