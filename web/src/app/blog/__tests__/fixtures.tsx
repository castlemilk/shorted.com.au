import { type Post } from "~/@/interfaces/post";

export const BODY_SENTINEL = "BODY-SENTINEL-must-not-render-on-the-index";

const make = (
  slug: string,
  date: string,
  category: Post["category"],
  extra: Partial<Post> = {},
): Post => ({
  slug,
  title: `Post ${slug}`,
  excerpt: `Excerpt for ${slug}`,
  coverImage: `/assets/blog/${slug}/cover.png`,
  date,
  category,
  tags: [`tag-${slug}`],
  author: {
    name: "Ben Ebsworth",
    picture: "/assets/blog/authors/ben-ebsworth.jpg",
  },
  ogImage: { url: `/assets/blog/${slug}/cover.png` },
  content: `# ${slug}\n\n${BODY_SENTINEL} ${"word ".repeat(300)}`,
  ...extra,
});

// Newest first, as getAllPosts() guarantees.
export const FIXTURE_POSTS: Post[] = [
  make("newest-housing", "2026-09-24", "housing"),
  make("guide-one", "2026-08-20", "guides"),
  make("analysis-one", "2026-07-11", "analysis"),
  make("guide-two", "2026-05-01", "guides"),
  make("product-one", "2026-02-12", "product"),
];
