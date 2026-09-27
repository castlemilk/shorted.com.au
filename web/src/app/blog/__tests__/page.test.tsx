import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import BlogIndexPage, { metadata } from "../page";
import { BODY_SENTINEL, FIXTURE_POSTS } from "./fixtures";

jest.mock("~/@/lib/api", () => ({
  getAllPosts: () => FIXTURE_POSTS,
  getPostBySlug: (slug: string) =>
    FIXTURE_POSTS.find((p) => p.slug === slug) ?? null,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...rest
  }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock("next/image", () => ({
  __esModule: true,
  default: ({
    fill,
    priority,
    ...rest
  }: Record<string, unknown> & { fill?: boolean; priority?: boolean }) => (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img
      {...(rest as React.ImgHTMLAttributes<HTMLImageElement>)}
      data-priority={priority ? "true" : undefined}
    />
  ),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
}));
jest.mock("~/@/components/seo/llm-meta", () => ({
  LLMMeta: () => null,
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
  ItemListStructuredData: ({
    items,
    itemType,
  }: {
    items: unknown[];
    itemType?: string;
  }) => (
    <div
      data-testid="itemlist"
      data-item-type={itemType}
      data-first={JSON.stringify(items[0])}
    >
      {items.length}
    </div>
  ),
}));

// The mono "N articles · Latest …" line under the page title.
const countLine = () =>
  screen.getByText(
    (_, el) =>
      el?.tagName === "P" && /^\d+ articles?/.test(el.textContent ?? ""),
  );

describe("BlogIndexPage", () => {
  it("features the newest post by excerpt only and never renders a post body", () => {
    render(<BlogIndexPage />);

    const [newest] = FIXTURE_POSTS;
    const featured = screen.getByRole("region", { name: newest!.title });
    expect(
      within(featured).getByRole("heading", { level: 2, name: newest!.title }),
    ).toBeInTheDocument();
    expect(within(featured).getByText(newest!.excerpt)).toBeInTheDocument();
    expect(within(featured).getByText("Latest")).toBeInTheDocument();
    expect(within(featured).getByText("Housing")).toBeInTheDocument();
    // The featured cover is the LCP element: eager, not lazy.
    expect(featured.querySelector("img[sizes]")).toHaveAttribute(
      "data-priority",
      "true",
    );

    expect(screen.queryByText(new RegExp(BODY_SENTINEL))).toBeNull();
  });

  it("renders every other post as a distinct card, once, newest first", () => {
    render(<BlogIndexPage />);

    const [newest, ...rest] = FIXTURE_POSTS;
    const grid = screen.getByRole("region", { name: "More articles" });
    const cards = within(grid).getAllByRole("article");
    expect(cards).toHaveLength(rest.length);
    cards.forEach((card, i) => {
      expect(
        within(card).getByRole("heading", { level: 3, name: rest[i]!.title }),
      ).toBeInTheDocument();
      expect(within(card).getByText(rest[i]!.excerpt)).toBeInTheDocument();
      expect(within(card).getAllByRole("link")).toHaveLength(1);
    });
    // The featured post is not repeated in the grid.
    expect(
      within(grid).queryByRole("heading", { name: newest!.title }),
    ).toBeNull();

    // Every post is linked exactly once from the listing.
    const hrefs = screen
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    for (const post of FIXTURE_POSTS) {
      expect(hrefs.filter((h) => h === `/blog/${post.slug}`)).toHaveLength(1);
    }
  });

  it("offers category hubs with counts and marks All as current", () => {
    render(<BlogIndexPage />);

    const nav = screen.getByRole("navigation", { name: "Blog categories" });
    const all = within(nav).getByRole("link", { name: /All/ });
    expect(all).toHaveAttribute("aria-current", "page");
    expect(all).toHaveAttribute("href", "/blog");
    expect(all).toHaveTextContent("5");

    const guides = within(nav).getByRole("link", { name: /Guides/ });
    expect(guides).toHaveAttribute("href", "/blog/category/guides");
    expect(guides).toHaveTextContent("2");
    expect(guides).not.toHaveAttribute("aria-current");

    expect(
      within(nav).getByRole("link", { name: /Housing/ }),
    ).toHaveTextContent("1");
    expect(
      within(nav).getByRole("link", { name: /Market analysis/ }),
    ).toHaveTextContent("1");
    expect(
      within(nav).getByRole("link", { name: /Product/ }),
    ).toHaveTextContent("1");
  });

  it("carries the page header, the article count and an ItemList of BlogPostings", () => {
    render(<BlogIndexPage />);

    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "Notes on shorting the ASX",
      }),
    ).toBeInTheDocument();
    expect(countLine()).toHaveTextContent("5 articles");
    expect(screen.getByRole("link", { name: "RSS" })).toHaveAttribute(
      "href",
      "/feed.xml",
    );

    const itemList = screen.getByTestId("itemlist");
    expect(itemList).toHaveTextContent("5");
    expect(itemList).toHaveAttribute("data-item-type", "BlogPosting");
    // Full BlogPosting nodes, not name/url stubs.
    expect(JSON.parse(itemList.getAttribute("data-first")!)).toMatchObject({
      headline: "Post newest-housing",
      url: "https://shorted.com.au/blog/newest-housing",
      image: "https://shorted.com.au/assets/blog/newest-housing/cover.png",
      datePublished: "2026-09-24",
      author: {
        name: "Ben Ebsworth",
        url: "https://shorted.com.au/authors/ben-ebsworth",
      },
    });
  });

  it("publishes a canonical, an OG card and no images key that would shadow opengraph-image.tsx", () => {
    expect(metadata.alternates?.canonical).toBe("https://shorted.com.au/blog");
    expect(metadata.openGraph).not.toHaveProperty("images");
    expect(String(metadata.title)).toMatch(/ASX Short Selling Blog/);
    expect(String(metadata.description).length).toBeLessThanOrEqual(160);
  });
});
