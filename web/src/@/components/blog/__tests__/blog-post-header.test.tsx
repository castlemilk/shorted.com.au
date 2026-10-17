import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";

import { BlogPostHeader } from "../blog-post-header";
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
  readingMinutes: 11,
};

describe("BlogPostHeader", () => {
  it("uses a concise masthead introduction without changing the listing excerpt", () => {
    render(<BlogPostHeader card={{ ...card, standfirst: "Read the short-position queue in context." }} />);
    expect(screen.getByText("Read the short-position queue in context.")).toHaveClass("article-summary");
    expect(screen.queryByText(card.excerpt)).toBeNull();
  });
  it("renders the masthead: category as text, serif h1, standfirst, byline, dated cover", () => {
    const { container } = render(
      <BlogPostHeader card={card} authorHref="/authors/ben-ebsworth" />,
    );

    // The breadcrumb above the header links the category; the eyebrow is text.
    expect(screen.getByText("Guides").closest("a")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: card.title }),
    ).toBeInTheDocument();
    expect(screen.getByText(card.excerpt)).toHaveClass("article-summary");

    const author = screen.getByRole("link", { name: /Ben Ebsworth/ });
    expect(author).toHaveAttribute("href", "/authors/ben-ebsworth");
    expect(author).toHaveAttribute("rel", "author");
    expect(screen.getByText("20 August 2026").closest("time")).toHaveAttribute(
      "dateTime",
      "2026-08-20",
    );
    expect(screen.getByText("11 min read")).toBeInTheDocument();
    expect(screen.queryByText(/Updated/)).toBeNull();

    // The cover is content (og:image, BlogPosting image): real alt, eager.
    const cover = container.querySelector("figure img");
    expect(cover).toHaveAttribute(
      "alt",
      `Cover illustration for ${card.title}`,
    );
    expect(cover).toHaveAttribute("data-priority", "true");
  });

  it("shows a revision date and falls back to a plain byline without a profile", () => {
    render(<BlogPostHeader card={card} updated="2026-09-01" />);

    expect(screen.queryByRole("link", { name: /Ben Ebsworth/ })).toBeNull();
    expect(screen.getByText("Ben Ebsworth")).toBeInTheDocument();
    expect(
      screen.getByText("1 September 2026").closest("time"),
    ).toHaveAttribute("dateTime", "2026-09-01");
  });

  it("uses the article's visual description as cover alt text when provided", () => {
    const coverAlt = "A magnifying lens isolates an amber candle crossing a resistance line";
    render(<BlogPostHeader card={{ ...card, coverAlt }} />);
    expect(screen.getByRole("img", { name: coverAlt })).toHaveAttribute("src", card.coverImage);
  });
});
