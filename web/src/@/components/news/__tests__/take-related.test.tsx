/// <reference types="jest" />
import "@testing-library/jest-dom";
import { render, screen } from "@testing-library/react";

const mockGetStock = jest.fn();
const mockGetStockNews = jest.fn();
const mockListEditorialTakes = jest.fn();

// next/link with the prefetch prop surfaced as data-prefetch so a test can read it.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    prefetch,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));
jest.mock("~/app/actions/getStock", () => ({
  getStock: (...a: unknown[]) => mockGetStock(...a),
}));
jest.mock("~/app/actions/getStockNews", () => ({
  getStockNews: (...a: unknown[]) => mockGetStockNews(...a),
}));
jest.mock("~/app/actions/getEditorialTake", () => ({
  listEditorialTakes: (...a: unknown[]) => mockListEditorialTakes(...a),
}));

import { TakeRelated } from "../take-related";

const stock = { name: "BHP Group", industry: "Materials", percentageShorted: 1.58 };
const article = {
  id: "a1",
  headline: "BHP lifts iron ore guidance",
  url: "https://example.test/a1",
  source: "Stockhead",
  sentiment: "positive",
  isPriceSensitive: false,
  publishedAt: "2026-10-01T00:00:00.000Z",
};

async function renderRail() {
  render(await TakeRelated({ stockCode: "BHP", excludeSlug: "this-take" }));
}

describe("TakeRelated", () => {
  beforeEach(() => {
    mockGetStock.mockReset();
    mockGetStock.mockResolvedValue(stock);
    mockGetStockNews.mockReset();
    mockGetStockNews.mockResolvedValue({ articles: [article] });
    mockListEditorialTakes.mockReset();
    mockListEditorialTakes.mockResolvedValue({ takes: [] });
  });

  // Every take page with a related-stock rail used to viewport-prefetch the
  // stock's News tab, an ISR route (600 s) that generates on a cold cache: a
  // standing exception to "intent-only prefetch". The link goes through the tab
  // registry, like every other link into a tab.
  it("links to the stock's News tab through the tab registry, with prefetch off", async () => {
    await renderRail();
    const link = screen.getByRole("link", { name: /All \$BHP news/ });
    expect(link).toHaveAttribute("href", "/shorts/BHP/news");
    expect(link).toHaveAttribute("data-prefetch", "false");
  });

  // JSX reads `${stockCode}` as the character "$" followed by the expression
  // {stockCode}, not as a template: the rail has always printed a cashtag
  // ("$BHP"), in its headings, its empty state and this link alike. Pinned so a
  // reader mistaking it for an unsubstituted template does not "fix" it.
  it("prints the stock as a cashtag, never as a literal template", async () => {
    mockGetStockNews.mockResolvedValue({ articles: [] });
    await renderRail();
    expect(screen.getByRole("heading", { name: "About $BHP" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "More on $BHP" })).toBeInTheDocument();
    expect(screen.getByText("No recent articles indexed for $BHP.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "All $BHP news →" })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("${stockCode}");
  });
});
