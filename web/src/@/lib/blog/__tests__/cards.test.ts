import { type Post } from "~/@/interfaces/post";
import {
  countByCategory,
  formatBlogDate,
  formatBlogDateLong,
  formatReadingMinutes,
  pickRelated,
  toBlogCard,
} from "../cards";

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
  content: "word ".repeat(450),
  ...overrides,
});

describe("toBlogCard", () => {
  it("keeps the listing fields, drops the body, and derives category + reading time", () => {
    const card = toBlogCard(post({ slug: "a", category: "housing" }));
    expect(card).toMatchObject({
      slug: "a",
      title: "Title a",
      excerpt: "Excerpt a",
      date: "2026-09-24",
      author: { name: "Ben Ebsworth" },
    });
    expect(card.category.slug).toBe("housing");
    // 450 words at 200 wpm, rounded up.
    expect(card.readingMinutes).toBe(3);
    expect("content" in card).toBe(false);
  });

  it("resolves a post without a declared category by slug", () => {
    expect(
      toBlogCard(post({ slug: "how-to-read-a-suburb-profile" })).category.slug,
    ).toBe("housing");
  });

  it("keeps the smaller card image separate from the full masthead cover", () => {
    const thumbnailImage = "/assets/blog/a/thumbnail-editorial-v2.webp";
    const card = toBlogCard(post({ slug: "a", thumbnailImage }));
    expect(card.thumbnailImage).toBe(thumbnailImage);
    expect(card.coverImage).toBe("/assets/blog/a/cover.png");
  });
});

describe("date + reading-time formatting", () => {
  it("formats en-AU short and long dates in UTC so the day never slips", () => {
    expect(formatBlogDate("2026-09-24")).toBe("24 Sept 2026");
    expect(formatBlogDateLong("2026-09-24")).toBe("24 September 2026");
    expect(formatBlogDate("2023-10-07T00:00:00.000Z")).toBe("7 Oct 2023");
  });

  it("shows a timestamp on the Australian calendar, not the UTC one", () => {
    expect(formatBlogDate("2026-10-01T09:00:00+10:00")).toBe("1 Oct 2026");
    expect(formatBlogDateLong("2026-10-01T09:00:00+10:00")).toBe(
      "1 October 2026",
    );
    // Midnight UTC on the 7th is late morning on the 7th in Sydney.
    expect(formatBlogDate("2023-10-07T00:00:00.000Z")).toBe("7 Oct 2023");
  });

  it("returns the raw string for an unparseable date", () => {
    expect(formatBlogDate("not a date")).toBe("not a date");
  });

  it("never reports under a minute", () => {
    expect(formatReadingMinutes(0)).toBe("1 min read");
    expect(formatReadingMinutes(7)).toBe("7 min read");
  });
});

describe("countByCategory", () => {
  it("counts every shelf, including empty ones, plus the total", () => {
    const cards = [
      toBlogCard(post({ slug: "a", category: "guides" })),
      toBlogCard(post({ slug: "b", category: "guides" })),
      toBlogCard(post({ slug: "c", category: "housing" })),
    ];
    expect(countByCategory(cards)).toEqual({
      all: 3,
      guides: 2,
      analysis: 0,
      housing: 1,
      product: 0,
    });
  });
});

describe("pickRelated", () => {
  const cards = [
    toBlogCard(post({ slug: "g1", category: "guides" })),
    toBlogCard(post({ slug: "h1", category: "housing" })),
    toBlogCard(post({ slug: "g2", category: "guides" })),
    toBlogCard(post({ slug: "p1", category: "product" })),
    toBlogCard(post({ slug: "g3", category: "guides" })),
  ];

  it("prefers the same category, keeps order, never includes the current post", () => {
    expect(pickRelated(cards, "g2").map((c) => c.slug)).toEqual([
      "g1",
      "g3",
      "h1",
    ]);
  });

  it("falls back to the newest posts when the current slug is unknown", () => {
    expect(pickRelated(cards, "missing", 2).map((c) => c.slug)).toEqual([
      "g1",
      "h1",
    ]);
  });
});
