/// <reference types="jest" />
import "@testing-library/jest-dom";
import { describe, it, expect } from "@jest/globals";

/**
 * The Overview's social card. A page that sets `openGraph` replaces the
 * segment's file-based opengraph-image, so the page names the card itself,
 * exactly as every tab does (stockOgImage). The object is pinned here from its
 * parts, not from the helper, so swapping the helper for an inline copy (or the
 * reverse) cannot change what crawlers and social previews see.
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("~/app/actions/getStock", () => ({ getStockOrNotFound: jest.fn() }));
jest.mock("~/app/actions/getLatestShortDate", () => ({
  getLatestShortDate: jest.fn(async () => null),
}));
jest.mock("~/app/actions/getDailyShortSeries", () => ({
  getDailyShortSeries: jest.fn(async () => []),
}));
jest.mock("~/app/actions/getRelatedStocks", () => ({
  getRelatedStocks: jest.fn(async () => ({
    stocks: [],
    industry: null,
    industrySlug: null,
  })),
}));

import { getStockOrNotFound } from "~/app/actions/getStock";
import { siteConfig } from "~/@/config/site";
import { generateMetadata } from "../page";

const mockGetStock = getStockOrNotFound as jest.Mock;

function stock(percentageShorted: number) {
  return {
    name: "BHP GROUP LIMITED ORDINARY",
    industry: "Materials",
    percentageShorted,
    reportedShortPositions: 60_000_000,
  };
}

function card(version: string) {
  return {
    url: `${siteConfig.url}/shorts/BHP/opengraph-image?p=${version}`,
    width: 1200,
    height: 630,
    alt: `BHP short position — ${siteConfig.name}`,
  };
}

describe("stock Overview metadata", () => {
  it.each([
    [1.2, "1.20"],
    [0, "default"],
  ])(
    "names the social card for a short interest of %s, versioned by it",
    async (percentageShorted, version) => {
      mockGetStock.mockResolvedValue(stock(percentageShorted));

      const meta = await generateMetadata({
        params: Promise.resolve({ stockCode: "bhp" }),
      });

      expect(meta.openGraph?.images).toEqual([card(version)]);
      expect(meta.twitter?.images).toEqual([card(version)]);
    },
  );

  // Next 14.2 merges metadata with `for (key in source)`: an own `robots` key
  // holding undefined replaces the root layout's robots (and its googleBot
  // max-image-preview / max-snippet directives) with nothing. Indexable means
  // no key at all.
  it("sets no robots key on an indexable stock, and a noindex on a thin stub", async () => {
    mockGetStock.mockResolvedValue(stock(1.2));
    const indexable = await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    expect(Object.keys(indexable)).not.toContain("robots");

    // No name, no industry and a short position under the indexing floor.
    mockGetStock.mockResolvedValue({ name: "", industry: "", percentageShorted: 0.01, reportedShortPositions: 0 });
    const thin = await generateMetadata({ params: Promise.resolve({ stockCode: "tny" }) });
    expect(thin.robots).toEqual({ index: false, follow: true, googleBot: { index: false, follow: true } });
  });

  it("sets no robots key while the stock read fails (fail open)", async () => {
    mockGetStock.mockRejectedValue(new Error("unavailable"));
    const meta = await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    expect(Object.keys(meta)).not.toContain("robots");
  });

  it("still names the default card when the stock read fails", async () => {
    mockGetStock.mockRejectedValue(new Error("unavailable"));

    const meta = await generateMetadata({
      params: Promise.resolve({ stockCode: "bhp" }),
    });

    expect(meta.openGraph?.images).toEqual([card("default")]);
    expect(meta.twitter?.images).toEqual([card("default")]);
  });
});
