import { blogItemListEntry } from "../structured-data";
import { toBlogCard } from "../cards";
import { type Post } from "~/@/interfaces/post";

const post = (overrides: Partial<Post> & { slug: string }): Post => ({
  title: `Title ${overrides.slug}`,
  date: "2026-09-24",
  coverImage: `/assets/blog/${overrides.slug}/cover.png`,
  author: {
    name: "Ben Ebsworth",
    picture: "/assets/blog/authors/ben-ebsworth.jpg",
  },
  excerpt: `Excerpt ${overrides.slug}`,
  ogImage: { url: `/assets/blog/${overrides.slug}/cover.png` },
  content: "body",
  ...overrides,
});

describe("blogItemListEntry", () => {
  it("emits a full BlogPosting node with absolute URLs and the author's profile", () => {
    expect(
      blogItemListEntry(toBlogCard(post({ slug: "a", category: "guides" }))),
    ).toEqual({
      name: "Title a",
      headline: "Title a",
      url: "https://shorted.com.au/blog/a",
      description: "Excerpt a",
      image: "https://shorted.com.au/assets/blog/a/cover.png",
      datePublished: "2026-09-24",
      author: {
        name: "Ben Ebsworth",
        url: "https://shorted.com.au/authors/ben-ebsworth",
      },
    });
  });

  it("omits what it does not have rather than emitting empty strings", () => {
    const entry = blogItemListEntry(
      toBlogCard(
        post({
          slug: "b",
          excerpt: "",
          coverImage: "",
          author: { name: "Guest Writer", picture: "" },
        }),
      ),
    );
    expect(entry.description).toBeUndefined();
    expect(entry.image).toBeUndefined();
    expect(entry.author).toEqual({ name: "Guest Writer" });
  });
});
