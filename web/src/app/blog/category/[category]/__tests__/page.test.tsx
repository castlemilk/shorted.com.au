import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import BlogCategoryPage, {
  generateMetadata,
  generateStaticParams,
} from "../page";
import { FIXTURE_POSTS } from "../../../__tests__/fixtures";

const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));
jest.mock("~/@/lib/api", () => ({
  getAllPosts: () => FIXTURE_POSTS,
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
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
  ItemListStructuredData: ({ items }: { items: unknown[] }) => (
    <div data-testid="itemlist">{items.length}</div>
  ),
}));

// The mono "N articles" line under the hub title.
const countLine = () =>
  screen.getByText(
    (_, el) =>
      el?.tagName === "P" && /^\d+ articles?$/.test(el.textContent ?? ""),
  );

describe("BlogCategoryPage", () => {
  beforeEach(() => notFound.mockClear());

  it("lists only the posts filed under the category as h2 cards, one eager cover", () => {
    const { container } = render(
      <BlogCategoryPage params={{ category: "guides" }} />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Short Selling Guides" }),
    ).toBeInTheDocument();
    const cards = screen.getAllByRole("article");
    expect(
      cards.map(
        (c) => within(c).getByRole("heading", { level: 2 }).textContent,
      ),
    ).toEqual(["Post guide-one", "Post guide-two"]);
    // Nothing sits between the h1 and the cards, so there is no h3 to skip to.
    expect(screen.queryAllByRole("heading", { level: 3 })).toHaveLength(0);
    expect(screen.queryByText("Post newest-housing")).toBeNull();
    expect(screen.getByTestId("itemlist")).toHaveTextContent("2");
    expect(countLine()).toHaveTextContent("2 articles");
    const covers = Array.from(container.querySelectorAll("img[sizes]"));
    expect(covers).toHaveLength(2);
    expect(covers[0]).toHaveAttribute("data-priority", "true");
    expect(covers[1]).not.toHaveAttribute("data-priority");
  });

  it("marks the current category in the chip row and keeps the counts global", () => {
    render(<BlogCategoryPage params={{ category: "housing" }} />);

    const nav = screen.getByRole("navigation", { name: "Blog categories" });
    expect(within(nav).getByRole("link", { name: /Housing/ })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: /All/ })).toHaveTextContent(
      "5",
    );
    expect(within(nav).getByRole("link", { name: /Guides/ })).toHaveTextContent(
      "2",
    );
    expect(countLine()).toHaveTextContent("1 article");
  });

  it("404s an unknown category instead of rendering an empty hub", () => {
    expect(() =>
      render(<BlogCategoryPage params={{ category: "nope" }} />),
    ).toThrow("NEXT_NOT_FOUND");
    // React replays a render that throws, so the call count is >= 1.
    expect(notFound).toHaveBeenCalled();
  });

  it("pre-renders every registry category and publishes a canonical per hub", () => {
    expect(generateStaticParams()).toEqual([
      { category: "guides" },
      { category: "analysis" },
      { category: "housing" },
      { category: "product" },
    ]);
    const meta = generateMetadata({ params: { category: "housing" } });
    expect(meta.alternates?.canonical).toBe(
      "https://shorted.com.au/blog/category/housing",
    );
    // Absolute, so the root "| Shorted" template cannot double-brand it.
    expect(meta.title).toEqual({
      absolute: "Australian Housing Data | Shorted Blog",
    });
    // A summary_large_image card needs an image; nested segments do not
    // inherit /blog's opengraph-image.tsx.
    expect(meta.openGraph?.images).toEqual([
      expect.objectContaining({
        url: "https://shorted.com.au/opengraph-image",
      }),
    ]);
    expect(meta.twitter?.images).toEqual([
      "https://shorted.com.au/opengraph-image",
    ]);
    expect(generateMetadata({ params: { category: "nope" } })).toEqual({});
  });
});
