import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { BlogPostCard } from "../blog-post-card";
import { type BlogCard } from "~/@/lib/blog/cards";
import { getBlogCategory } from "~/@/lib/blog/categories";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    ...rest
  }: React.PropsWithChildren<{ href: string; className?: string }>) => (
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
      data-fill={fill ? "true" : undefined}
      data-priority={priority ? "true" : undefined}
    />
  ),
}));

const card: BlogCard = {
  slug: "days-to-cover-asx",
  title: "Days to Cover on the ASX",
  excerpt: "Days to cover measures how long the shorts would need to exit.",
  coverImage: "/assets/blog/days-to-cover-asx/cover.png",
  date: "2026-08-20",
  author: {
    name: "Ben Ebsworth",
    picture: "/assets/blog/authors/ben-ebsworth.jpg",
  },
  category: getBlogCategory("guides")!,
  readingMinutes: 6,
};

describe("BlogPostCard", () => {
  it("renders the meta row, headline, excerpt and byline with exactly one link", () => {
    render(<BlogPostCard card={card} />);

    expect(screen.getByText("Guides")).toBeInTheDocument();
    expect(screen.getByText("6 min read")).toBeInTheDocument();
    const heading = screen.getByRole("heading", { level: 3, name: card.title });
    expect(heading).toBeInTheDocument();
    expect(heading.className).toContain("font-serif");
    expect(screen.getByText(card.excerpt)).toBeInTheDocument();
    expect(screen.getByText("Ben Ebsworth")).toBeInTheDocument();
    expect(screen.getByText("20 Aug 2026").closest("time")).toHaveAttribute(
      "dateTime",
      "2026-08-20",
    );

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(1);
    expect(links[0]).toHaveAttribute("href", "/blog/days-to-cover-asx");
    // The title link stretches over the whole card.
    expect(links[0]?.className).toContain("after:absolute");
  });

  it("ships a responsive sizes hint and lazy-loads unless told otherwise", () => {
    const { container, rerender } = render(<BlogPostCard card={card} />);
    const cover = container.querySelector("img[sizes]");
    expect(cover).toHaveAttribute("sizes", expect.stringContaining("33vw"));
    expect(cover).toHaveAttribute("alt", "");
    expect(cover).not.toHaveAttribute("data-priority");

    rerender(<BlogPostCard card={card} priority />);
    expect(container.querySelector("img[sizes]")).toHaveAttribute(
      "data-priority",
      "true",
    );
  });

  it("honours the heading level and the compact variant (mono, not serif)", () => {
    render(<BlogPostCard card={card} variant="compact" headingLevel="h2" />);
    const heading = screen.getByRole("heading", { level: 2, name: card.title });
    expect(heading.className).toContain("line-clamp-2");
    expect(heading.className).toContain("font-mono");
    expect(heading.className).not.toContain("font-serif");
    expect(screen.getByText(card.excerpt).className).toContain("line-clamp-2");
  });

  it("renders without an author picture or cover", () => {
    const { container } = render(
      <BlogPostCard
        card={{
          ...card,
          coverImage: "",
          author: { name: "Shorted", picture: "" },
        }}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText("Shorted")).toBeInTheDocument();
  });
});
