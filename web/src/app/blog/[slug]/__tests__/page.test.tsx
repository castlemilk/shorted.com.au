import React from "react";
import { render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom";

import Post, { generateMetadata } from "../page";
import { BODY_SENTINEL, FIXTURE_POSTS } from "../../__tests__/fixtures";

const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
}));
jest.mock("~/@/lib/api", () => ({
  getAllPosts: () => FIXTURE_POSTS,
  getPostBySlug: (slug: string) =>
    FIXTURE_POSTS.find((p) => p.slug === slug) ?? null,
}));
jest.mock("next-mdx-remote/rsc", () => ({
  MDXRemote: ({ source }: { source: string }) => (
    <div data-testid="mdx">{source}</div>
  ),
}));
jest.mock("remark-gfm", () => ({ __esModule: true, default: () => undefined }));
jest.mock("prismjs/themes/prism-tomorrow.css", () => ({}));
jest.mock("~/@/components/blog/mdx-components", () => ({
  blogMdxComponents: {},
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
  BreadcrumbStructuredData: ({
    items,
  }: {
    items: Array<{ label: string; href: string }>;
  }) => <div data-testid="breadcrumb-ld">{JSON.stringify(items)}</div>,
}));
jest.mock("~/@/components/seo/article-schema", () => ({
  ArticleSchema: (props: Record<string, unknown>) => (
    <div data-testid="article-schema">{JSON.stringify(props)}</div>
  ),
}));
jest.mock("~/@/components/seo/llm-meta", () => ({
  LLMMeta: (props: Record<string, unknown>) => (
    <div data-testid="llm-meta">{JSON.stringify(props)}</div>
  ),
}));
jest.mock("~/@/components/seo/social-share", () => ({
  SocialShare: ({ url }: { url: string }) => (
    <div data-testid="social-share">{url}</div>
  ),
}));

const [newestHousing, guideOne] = FIXTURE_POSTS;

describe("blog article page", () => {
  beforeEach(() => notFound.mockClear());

  it("renders the masthead, the body, the byline link and a same-category-first rail", async () => {
    render(await Post({ params: { slug: guideOne!.slug } }));

    expect(
      screen.getByRole("heading", { level: 1, name: guideOne!.title }),
    ).toBeInTheDocument();
    // The eyebrow is a <p>; the rail's card labels are spans.
    expect(screen.getByText("Guides", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByTestId("mdx")).toHaveTextContent(BODY_SENTINEL);
    expect(screen.getByRole("link", { name: /Ben Ebsworth/ })).toHaveAttribute(
      "href",
      "/authors/ben-ebsworth",
    );
    expect(screen.getByTestId("social-share")).toHaveTextContent(
      "https://shorted.com.au/blog/guide-one",
    );

    // Keep reading: the other guide first, then the newest of the rest.
    const rail = screen.getByRole("region", { name: "Keep reading" });
    const titles = within(rail)
      .getAllByRole("heading", { level: 3 })
      .map((h) => h.textContent);
    expect(titles).toEqual([
      "Post guide-two",
      "Post newest-housing",
      "Post analysis-one",
    ]);
    expect(within(rail).queryByText(guideOne!.title)).toBeNull();
  });

  it("emits BlogPosting JSON-LD with the category as section, the author profile and the tags", async () => {
    render(await Post({ params: { slug: newestHousing!.slug } }));

    const schema = JSON.parse(
      screen.getByTestId("article-schema").textContent!,
    );
    expect(schema).toMatchObject({
      type: "BlogPosting",
      title: newestHousing!.title,
      articleSection: "Housing",
      authorSlug: "ben-ebsworth",
      datePublished: "2026-09-24",
      url: "https://shorted.com.au/blog/newest-housing",
    });
    expect(schema.keywords).toEqual(
      expect.arrayContaining(["tag-newest-housing", "Housing"]),
    );

    const llm = JSON.parse(screen.getByTestId("llm-meta").textContent!);
    expect(llm.datePublished).toBe("2026-09-24");
    expect(llm.lastUpdated).toBe("2026-09-24");

    const crumbs = JSON.parse(screen.getByTestId("breadcrumb-ld").textContent!);
    expect(crumbs.map((c: { href: string }) => c.href)).toEqual([
      "/blog",
      "/blog/category/housing",
      "/blog/newest-housing",
    ]);
  });

  it("404s an unknown slug", async () => {
    await expect(Post({ params: { slug: "nope" } })).rejects.toThrow(
      "NEXT_NOT_FOUND",
    );
    expect(notFound).toHaveBeenCalled();
  });

  it("publishes article OpenGraph with section, tags and a canonical", () => {
    const meta = generateMetadata({ params: { slug: newestHousing!.slug } });
    expect(meta.alternates?.canonical).toBe(
      "https://shorted.com.au/blog/newest-housing",
    );
    expect(meta.openGraph).toMatchObject({
      type: "article",
      section: "Housing",
      tags: ["tag-newest-housing"],
      publishedTime: "2026-09-24",
    });
    expect(meta.keywords).toEqual(
      expect.arrayContaining(["tag-newest-housing", "Housing", "blog"]),
    );
  });
});
