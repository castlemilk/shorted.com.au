import { type Author } from "./author";

export type Post = {
  slug: string;
  title: string;
  date: string;
  /** Optional ISO date of the last substantive revision (schema dateModified). */
  updated?: string;
  coverImage: string;
  author: Author;
  excerpt: string;
  /**
   * Blog category slug (see `~/@/lib/blog/categories`). Optional in the
   * frontmatter so an uncategorised post still renders; the registry
   * falls back to a slug heuristic and the contract test flags it.
   */
  category?: string;
  /** Free-form topic tags: page keywords + JSON-LD keywords. */
  tags?: string[];
  ogImage: {
    url: string;
  };
  content: string;
  preview?: boolean;
};
