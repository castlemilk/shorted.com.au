import { siteConfig } from "~/@/config/site";
import { AUTHORS } from "~/@/data/authors";
import { type BlogCard, blogPostPath } from "./cards";

const absolute = (path: string): string =>
  path.startsWith("/") ? `${siteConfig.url}${path}` : path;

/**
 * One post as a full BlogPosting node for an ItemList (headline, image,
 * datePublished, author). A listed article with only name and url reads as
 * a partial Article to validators; this carries the recommended set.
 */
export function blogItemListEntry(card: BlogCard) {
  const authorSlug = AUTHORS.find((a) => a.name === card.author.name)?.slug;
  return {
    name: card.title,
    headline: card.title,
    url: absolute(blogPostPath(card.slug)),
    description: card.excerpt || undefined,
    image: card.coverImage ? absolute(card.coverImage) : undefined,
    datePublished: card.date,
    author: {
      name: card.author.name,
      ...(authorSlug ? { url: absolute(`/authors/${authorSlug}`) } : {}),
    },
  };
}
