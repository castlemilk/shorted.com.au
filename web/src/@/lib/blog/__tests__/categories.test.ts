import fs from "fs";
import path from "path";
import matter from "gray-matter";

import { AUTHORS } from "~/@/data/authors";

import {
  BLOG_CATEGORIES,
  BLOG_CATEGORY_SLUGS,
  blogCategoryPath,
  getBlogCategory,
  isBlogCategorySlug,
  resolveCategory,
} from "../categories";

const BLOGS_DIR = path.join(process.cwd(), "_blogs");
const PUBLIC_DIR = path.join(process.cwd(), "public");

interface Frontmatter {
  title?: string;
  excerpt?: string;
  coverImage?: string;
  date?: string;
  updated?: string;
  category?: string;
  tags?: unknown;
  author?: { name?: string; picture?: string };
  ogImage?: { url?: string };
}

const posts = fs
  .readdirSync(BLOGS_DIR)
  .filter((file) => /\.mdx?$/i.test(file))
  .map((file) => ({
    file,
    slug: file.replace(/\.mdx?$/i, ""),
    data: matter(fs.readFileSync(path.join(BLOGS_DIR, file), "utf8"))
      .data as Frontmatter,
  }));

describe("blog category registry", () => {
  it("has unique slugs, labels and hub paths", () => {
    const slugs = BLOG_CATEGORIES.map((c) => c.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(BLOG_CATEGORY_SLUGS).toEqual(slugs);
    for (const category of BLOG_CATEGORIES) {
      expect(category.label).not.toBe("");
      expect(category.title).not.toBe("");
      expect(category.description.length).toBeGreaterThan(40);
      expect(blogCategoryPath(category.slug)).toBe(
        `/blog/category/${category.slug}`,
      );
      expect(getBlogCategory(category.slug)).toBe(category);
      expect(isBlogCategorySlug(category.slug)).toBe(true);
    }
    expect(isBlogCategorySlug("nope")).toBe(false);
    expect(isBlogCategorySlug(undefined)).toBe(false);
    expect(getBlogCategory("nope")).toBeUndefined();
  });

  it("prefers a declared category over the slug heuristic", () => {
    expect(
      resolveCategory({ slug: "house-prices-fall", category: "product" }).slug,
    ).toBe("product");
  });

  it("falls back to a slug heuristic for a missing or unknown category", () => {
    expect(resolveCategory({ slug: "melbourne-house-prices-fall" }).slug).toBe(
      "housing",
    );
    expect(
      resolveCategory({ slug: "shorted-new-feature", category: "typo" }).slug,
    ).toBe("product");
    expect(
      resolveCategory({ slug: "asx-sectors-most-shorted-2027" }).slug,
    ).toBe("guides");
    // Tokens match whole slug segments, not substrings.
    expect(
      resolveCategory({ slug: "current-short-interest-on-cba" }).slug,
    ).toBe("guides");
    expect(resolveCategory({ slug: "a-thousand-shorts-later" }).slug).toBe(
      "guides",
    );
    expect(resolveCategory({ slug: "parent-company-shorts" }).slug).toBe(
      "guides",
    );
    expect(
      resolveCategory({ slug: "most-shorted-asx-stocks-october-2026-update" })
        .slug,
    ).toBe("analysis");
    expect(resolveCategory({ slug: "melbourne-rent-tracker" }).slug).toBe(
      "housing",
    );
    // A declared value survives stray whitespace and capitals.
    expect(resolveCategory({ slug: "x", category: " Housing " }).slug).toBe(
      "housing",
    );
    expect(
      resolveCategory({ slug: "most-shorted-asx-stocks-august" }).slug,
    ).toBe("analysis");
    expect(resolveCategory({ slug: "what-is-a-short-position" }).slug).toBe(
      "guides",
    );
  });
});

describe("_blogs frontmatter contract", () => {
  it("finds the published posts", () => {
    expect(posts.length).toBeGreaterThan(0);
  });

  it.each(posts.map((p) => [p.file, p] as const))(
    "%s declares a known category and at least one tag",
    (_file, post) => {
      expect(isBlogCategorySlug(post.data.category)).toBe(true);
      expect(Array.isArray(post.data.tags)).toBe(true);
      expect((post.data.tags as unknown[]).length).toBeGreaterThan(0);
      for (const tag of post.data.tags as unknown[]) {
        expect(typeof tag).toBe("string");
        expect((tag as string).trim()).not.toBe("");
      }
    },
  );

  it.each(posts.map((p) => [p.file, p] as const))(
    "%s carries every field a card renders, with a real cover file",
    (_file, post) => {
      expect(post.data.title?.trim()).toBeTruthy();
      expect(post.data.excerpt?.trim()).toBeTruthy();
      // The byline links /authors/<slug> and the JSON-LD author URL by exact
      // name match, and both degrade silently on a miss.
      expect(AUTHORS.map((a) => a.name)).toContain(post.data.author?.name);
      expect(post.data.author?.picture).toMatch(/^\//);
      expect(
        fs.existsSync(path.join(PUBLIC_DIR, post.data.author!.picture!)),
      ).toBe(true);
      expect(Number.isNaN(new Date(post.data.date ?? "").getTime())).toBe(
        false,
      );
      if (post.data.updated) {
        expect(Number.isNaN(new Date(post.data.updated).getTime())).toBe(false);
      }
      expect(post.data.coverImage).toMatch(/^\//);
      expect(fs.existsSync(path.join(PUBLIC_DIR, post.data.coverImage!))).toBe(
        true,
      );
      expect(post.data.ogImage?.url).toMatch(/^\//);
    },
  );

  it("keeps the slug heuristic in agreement with every declared category", () => {
    // Declared always wins at runtime. This pins the fallback against the
    // real catalogue so a future post published without a category lands
    // on the shelf its slug suggests, and a heuristic drift shows up here
    // as "slug: heuristic=x declared=y" rather than as a misfiled card.
    const disagreements = posts
      .filter((p) => resolveCategory({ slug: p.slug }).slug !== p.data.category)
      .map(
        (p) =>
          `${p.slug}: heuristic=${resolveCategory({ slug: p.slug }).slug} declared=${p.data.category}`,
      );
    expect(disagreements).toEqual([]);
  });
});
