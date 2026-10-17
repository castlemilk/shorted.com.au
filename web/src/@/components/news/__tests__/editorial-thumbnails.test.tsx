import React from "react";
import { render, screen } from "@testing-library/react";
import { preload } from "react-dom";
import { listEditorialTakes } from "~/app/actions/getEditorialTake";
import { TakeCardGrid } from "../take-card-grid";
import { FeaturedStory } from "../masthead/featured-story";
import { LeadStory } from "../masthead/lead-story";
import { FEATURED } from "../masthead/featured";
import type { TakeLike } from "../masthead/shared";

jest.mock("~/app/actions/getEditorialTake", () => ({ listEditorialTakes: jest.fn() }));
jest.mock("react-dom", () => ({ ...jest.requireActual("react-dom"), preload: jest.fn() }));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, ...props }: React.PropsWithChildren<{ href: string }>) => <a href={href} {...props}>{children}</a>,
}));
jest.mock("next/image", () => ({
  __esModule: true,
  default: ({ fill: _fill, priority: _priority, ...props }: Record<string, unknown>) => (
    // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
    <img {...(props as React.ImgHTMLAttributes<HTMLImageElement>)} />
  ),
}));

const makeTake = (slug: string, stockCode = ""): TakeLike => ({
  id: slug,
  slug,
  stockCode,
  headline: `Story ${slug}`,
  heroImageUrl: `https://storage.googleapis.com/editorial/${slug}.png`,
  publishedAt: { seconds: 1785801600 },
});

describe("Shorted editorial thumbnails", () => {
  beforeEach(() => jest.clearAllMocks());

  it("keeps the newest take per ticker, excludes the current article, and retains separate market stories", async () => {
    (listEditorialTakes as jest.Mock).mockResolvedValue({
      takes: [
        makeTake("bhp-new", "BHP"),
        makeTake("bhp-old", "bhp"),
        makeTake("current", "CSL"),
        makeTake("market-a"),
        makeTake("market-b"),
        makeTake("rio", "RIO"),
      ],
    });
    const { container } = render(await TakeCardGrid({ limit: 4, excludeSlug: "current" }));
    expect(listEditorialTakes).toHaveBeenCalledWith(16, 0, "");
    expect(screen.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([
      "/news/bhp-new", "/news/market-a", "/news/market-b", "/news/rio",
    ]);
    expect(screen.queryByText("Story bhp-old")).not.toBeInTheDocument();
    expect(screen.queryByText("Story current")).not.toBeInTheDocument();
    const images = [...container.querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("loading"))).toEqual(["eager", "eager", "eager", "lazy"]);
    for (const image of images) expect(image).toHaveAttribute("alt", "");
    const firstLink = screen.getAllByRole("link")[0]!;
    expect(firstLink).toHaveAccessibleName(/Story bhp-new/);
    // Stock metadata remains readable within the card rather than disappearing
    // with the removed image overlay.
    expect(firstLink).toHaveTextContent("$BHP");
  });

  it("renders no empty card section when the editorial service is unavailable", async () => {
    (listEditorialTakes as jest.Mock).mockRejectedValue(new Error("unavailable"));
    expect(await TakeCardGrid({})).toBeNull();
  });

  it("preserves the feature link and responsive image optimizer/preload path", () => {
    const item = {
      href: "/features/the-widow-maker",
      kicker: "Featured investigation",
      headline: "The Widow-Maker",
      standfirst: "Why betting against housing keeps failing",
      image: "/features/the-widow-maker/opengraph-image",
      meta: ["27 sources"],
    };
    const { container } = render(<FeaturedStory item={item} priority />);
    const image = container.querySelector("img")!;
    const optimized = `/_next/image?url=${encodeURIComponent(item.image)}&w=828&q=70`;
    expect(screen.getByRole("link")).toHaveAttribute("href", item.href);
    expect(screen.getByRole("heading", { name: item.headline })).toBeInTheDocument();
    expect(preload).toHaveBeenCalledWith(optimized, { as: "image" });
    expect(image).toHaveAttribute("src", optimized);
    expect(image).toHaveAttribute("fetchpriority", "high");
    // A legacy social card contains type, so preserving the whole image avoids
    // cutting its words when it sits inside the shared 16:9 artwork slot.
    expect(image).toHaveClass("object-contain");
  });

  it("keeps editorial caption and credit alongside the lead story artwork", () => {
    render(<LeadStory take={{
      ...makeTake("oil"),
      heroCaption: "Illustration: oil samples passing through a narrow gate",
      heroCredit: "Shorted illustration",
    }} />);
    expect(screen.getByText("Illustration: oil samples passing through a narrow gate")).toBeInTheDocument();
    expect(screen.getByText("Shorted illustration")).toBeInTheDocument();
    expect(screen.getByRole("link")).toHaveAttribute("href", "/news/oil");
  });

  it("uses dedicated artwork for the pinned investigation instead of its typed social card", () => {
    const { container } = render(<FeaturedStory item={FEATURED[0]!} />);
    expect(container.querySelector("img")).toHaveAttribute("src", expect.stringContaining(encodeURIComponent(FEATURED[0]!.image!)));
    expect(container.querySelector("img")).toHaveClass("object-cover");
    expect(screen.getByRole("link")).toHaveAttribute("href", "/features/the-widow-maker");
  });
});
