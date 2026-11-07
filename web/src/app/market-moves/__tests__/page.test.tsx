import fs from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import type { MarketMoveView } from "~/@/lib/market-moves/view";

const mockGetMarketMovesFeed = jest.fn<
  Promise<MarketMoveView[] | undefined>,
  []
>();
const mockBailOnEmptyRender = jest.fn(async () => undefined);

jest.mock("~/app/actions/market-moves/getMarketMoves", () => ({
  getMarketMovesFeed: () => mockGetMarketMovesFeed(),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => mockBailOnEmptyRender(),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
}));
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
  }: {
    children: React.ReactNode;
    href: string;
  }) => <a href={href}>{children}</a>,
}));

import MarketMovesPage, { metadata, revalidate } from "../page";

function view(overrides: Partial<MarketMoveView> = {}): MarketMoveView {
  return {
    moveKey: "k1",
    kind: "market",
    stockCode: null,
    companyName: null,
    indexCode: null,
    sector: null,
    relatedCodes: [],
    direction: "down",
    changePct: -1.4,
    price: null,
    volumeRatio: null,
    headline: "ASX slides as rate fears return",
    summary: "The market fell across every sector after the RBA minutes.",
    sources: [],
    tags: [],
    significance: 4,
    observedAt: "2026-11-07T03:05:00Z",
    marketDate: "2026-11-07",
    revision: 1,
    publishedAt: "2026-11-07T03:06:00Z",
    updatedAt: "2026-11-07T03:06:00Z",
    model: null,
    ...overrides,
  };
}

async function renderPage() {
  return render(await MarketMovesPage());
}

beforeEach(() => {
  mockGetMarketMovesFeed.mockReset();
  mockBailOnEmptyRender.mockClear();
});

describe("/market-moves", () => {
  it("is ISR and reads no request data", () => {
    expect(revalidate).toBe(300);
    const source = fs.readFileSync(
      path.join(__dirname, "..", "page.tsx"),
      "utf8",
    );
    expect(source).not.toMatch(
      /searchParams|cookies\(|headers\(|auth\(|no-store|force-dynamic/,
    );
    expect(source).not.toMatch(/^["']use client["']/m);
  });

  it("states its title and canonical", () => {
    expect(metadata.title).toBe("ASX Market Moves");
    expect(metadata.alternates?.canonical).toBe(
      "https://shorted.com.au/market-moves",
    );
  });

  it("groups the moves by market date, newest first", async () => {
    mockGetMarketMovesFeed.mockResolvedValue([
      view({ moveKey: "a", marketDate: "2026-11-07" }),
      view({
        moveKey: "b",
        marketDate: "2026-11-06",
        headline: "Miners rally on China stimulus",
      }),
    ]);
    const { container } = await renderPage();
    const dates = Array.from(container.querySelectorAll("h2 time")).map((t) =>
      t.getAttribute("dateTime"),
    );
    expect(dates).toEqual(["2026-11-07", "2026-11-06"]);
    expect(container.querySelector("#move-a")).not.toBeNull();
    expect(container.querySelector("#move-b")).not.toBeNull();
    expect(container.querySelector('[data-isr-shell="empty"]')).toBeNull();
    expect(mockBailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("says plainly when no move has been posted", async () => {
    mockGetMarketMovesFeed.mockResolvedValue([]);
    const { container } = await renderPage();
    expect(screen.getByText("No market moves posted yet.")).toBeTruthy();
    expect(container.querySelector('[data-isr-shell="empty"]')).toBeNull();
    expect(mockBailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("says the moves are unavailable, never that there are none, when they cannot be read", async () => {
    mockGetMarketMovesFeed.mockResolvedValue(undefined);
    const { container } = await renderPage();
    expect(
      screen.getByText(/Market moves are unavailable right now/),
    ).toBeTruthy();
    expect(screen.queryByText("No market moves posted yet.")).toBeNull();
    expect(container.querySelector('[data-isr-shell="empty"]')).not.toBeNull();
    expect(mockBailOnEmptyRender).toHaveBeenCalledTimes(1);
  });
});
