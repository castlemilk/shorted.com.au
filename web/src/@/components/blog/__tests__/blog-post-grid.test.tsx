import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import { BlogPostGrid } from "../blog-post-grid";
import { type BlogCard } from "~/@/lib/blog/cards";
import { getBlogCategory } from "~/@/lib/blog/categories";

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

const cards: BlogCard[] = Array.from({ length: 5 }, (_, i) => ({
  slug: `post-${i}`,
  title: `Post ${i}`,
  excerpt: `Excerpt ${i}`,
  coverImage: `/assets/blog/post-${i}/cover.png`,
  date: "2026-08-20",
  author: { name: "Ben Ebsworth", picture: "" },
  category: getBlogCategory("guides")!,
  readingMinutes: 3,
}));

describe("BlogPostGrid", () => {
  it("renders a list with one card per post and eager covers only up to priorityCount", () => {
    const { container } = render(
      <BlogPostGrid cards={cards} priorityCount={3} />,
    );

    const items = within(screen.getByRole("list")).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    const covers = Array.from(container.querySelectorAll("img[sizes]"));
    expect(covers.map((img) => img.getAttribute("data-priority"))).toEqual([
      "true",
      "true",
      "true",
      null,
      null,
    ]);
    // Same responsive shape on every surface: the card's sizes hint assumes it.
    expect(screen.getByRole("list").className).toContain("sm:grid-cols-2");
    expect(screen.getByRole("list").className).toContain("lg:grid-cols-3");
  });

  it("forwards the heading level and variant to every card", () => {
    render(<BlogPostGrid cards={cards} headingLevel="h2" variant="compact" />);

    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(5);
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(
      screen.getByRole("heading", { level: 2, name: "Post 0" }).className,
    ).toContain("font-mono");
  });

  it("renders nothing for an empty list", () => {
    const { container } = render(<BlogPostGrid cards={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
