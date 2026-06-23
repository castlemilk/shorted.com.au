/**
 * Curated, hand-built feature investigations that live outside the DB-driven
 * editorial_takes pipeline (bespoke `/features/*` pages). These are pinned into
 * the /news masthead as a "Featured investigation" card so flagship long-reads
 * stay discoverable without being faked as auto-generated takes.
 *
 * Newest first; the masthead pins the first entry.
 */
export interface FeaturedItem {
  /** Where the card links — a bespoke feature page, not /news/[slug]. */
  href: string;
  /** Small amber eyebrow, e.g. "Featured investigation". */
  kicker: string;
  headline: string;
  standfirst: string;
  /** Optional card art (e.g. the page's OG image route). */
  image?: string;
  /** Short meta facts, joined with dots under the standfirst. */
  meta?: string[];
}

export const FEATURED: FeaturedItem[] = [
  {
    href: "/features/the-widow-maker",
    kicker: "Featured investigation",
    headline: "The Widow-Maker",
    standfirst:
      "Why betting against Australian housing keeps failing — negative gearing, the 1999 CGT switch, the buying power of four banks, and what Japan and China teach about the day it breaks.",
    image: "/features/the-widow-maker/opengraph-image",
    meta: ["4 interactive dashboards", "27 sources", "23 June 2026"],
  },
];
