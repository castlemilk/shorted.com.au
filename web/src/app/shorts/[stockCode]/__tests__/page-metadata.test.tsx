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
import { getLatestShortDate } from "~/app/actions/getLatestShortDate";
import { siteConfig } from "~/@/config/site";
import { generateMetadata } from "../page";

const mockGetStock = getStockOrNotFound as jest.Mock;
const mockLatestDate = getLatestShortDate as jest.Mock;

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

  it("names a real industry in the description, and leaves a placeholder out", async () => {
    mockGetStock.mockResolvedValue(stock(1.2));
    const real = await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    expect(real.description).toContain(" Industry: Materials.");

    // What the ASX puts in the field of an ETF or a trust.
    for (const industry of ["Not Applic", "Class Pend"]) {
      mockGetStock.mockResolvedValue({ ...stock(1.2), industry });
      const meta = await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
      expect(meta.description).not.toContain("Industry:");
      expect(meta.description).not.toContain(industry);
    }
  });

  // The description leaves the placeholder out, but the index gate must still
  // see it: AFI, a listed investment company 0.008% shorted, has no other
  // industry. Handing the gate industryLabel's "" would noindex it.
  it("keeps a stock whose industry is a placeholder indexable (AFI)", async () => {
    mockGetStock.mockResolvedValue({
      name: "AUSTRALIAN FOUNDATION INVESTMENT COMPANY LIMITED",
      industry: "Not Applic",
      percentageShorted: 0.008,
      reportedShortPositions: 100_000,
    });
    const meta = await generateMetadata({ params: Promise.resolve({ stockCode: "afi" }) });
    expect(Object.keys(meta)).not.toContain("robots");
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

  // Titles stay inside Google's display width; the old form ran ~70
  // characters before the root template's " | Shorted".
  it("leads with the code and the live short %, in a short title", async () => {
    mockLatestDate.mockResolvedValueOnce(new Date());
    mockGetStock.mockResolvedValue(stock(1.2));
    const meta = await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    expect(meta.title).toMatch(/^BHP Short Interest: 1\.20% \(/);
    expect(String(meta.title).length).toBeLessThanOrEqual(50);
    expect(meta.description).toContain("Updated daily");
  });

  // A position that rounds to 0.00 is no level to state: ANT, 164 shares
  // short, was titled "ANT Short Interest: 0.00% (Arcadia Minerals, ASX)".
  it("states no level when the short % rounds to 0.00", async () => {
    mockLatestDate.mockResolvedValueOnce(new Date());
    mockGetStock.mockResolvedValue({
      name: "ARCADIA MINERALS LIMITED",
      industry: "Materials",
      percentageShorted: 0.00014,
      reportedShortPositions: 164,
    });
    const meta = await generateMetadata({ params: Promise.resolve({ stockCode: "ant" }) });
    expect(meta.title).toBe("ANT Short Interest (Arcadia Minerals, ASX)");
    expect(meta.description).toMatch(
      /^Arcadia Minerals short selling data from official ASIC reports\. /,
    );
    expect(meta.description).not.toContain("%");
  });

  // The edge read returns the API's JSON as sent, and protojson leaves a zero
  // float out, so percentageShorted can be missing altogether. Formatting it
  // before the check threw: the catch served the generic title and skipped
  // the noindex gate.
  it("states no level, and still gates indexing, when the short % is absent", async () => {
    mockGetStock.mockResolvedValue({
      name: "ARCADIA MINERALS LIMITED",
      industry: "Materials",
      reportedShortPositions: 0,
    });
    const named = await generateMetadata({ params: Promise.resolve({ stockCode: "ant" }) });
    expect(named.title).toBe("ANT Short Interest (Arcadia Minerals, ASX)");
    expect(named.description).toMatch(
      /^Arcadia Minerals short selling data from official ASIC reports\. /,
    );

    mockGetStock.mockResolvedValue({ name: "", industry: "", reportedShortPositions: 0 });
    const stub = await generateMetadata({ params: Promise.resolve({ stockCode: "tny" }) });
    expect(stub.robots).toEqual({ index: false, follow: true, googleBot: { index: false, follow: true } });
  });

  // A stock that left ASIC's report long ago must not claim a live figure
  // (AGF read "2.52% Shorted ... Updated daily" from a 2016 report).
  it("drops the live claims when the latest report is stale", async () => {
    mockLatestDate.mockResolvedValueOnce(new Date("2016-12-30T00:00:00Z"));
    mockGetStock.mockResolvedValue(stock(2.52));
    const meta = await generateMetadata({ params: Promise.resolve({ stockCode: "bhp" }) });
    expect(meta.title).not.toContain("%");
    expect(meta.description).toContain("last appeared in ASIC's short position report on 30 Dec 2016, at 2.52% short.");
    expect(meta.description).not.toContain("Updated daily");
    expect(meta.description).not.toContain("30 days");
  });
});
