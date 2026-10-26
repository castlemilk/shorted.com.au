/// <reference types="jest" />
import { describe, expect, it, beforeEach } from "@jest/globals";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { render } from "@testing-library/react";

/**
 * The homepage Dataset's dateModified is the ASIC report date its top-shorts
 * read runs to: the date the visible "as at" stamp shows. The page computed it
 * (asicAsOf) but never passed it, so the JSON-LD carried the render time
 * (2026-10-21T00:34:49Z against data that ran to 2026-10-15).
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("next/dynamic", () => () => () => null);
jest.mock("~/app/actions/getTopShorts", () => ({ getTopShortsData: jest.fn() }));
jest.mock("~/app/actions/getIndustryTreeMap", () => ({
  getIndustryTreeMap: jest.fn(async () => undefined),
}));
jest.mock("~/app/actions/reports/getReportData", () => ({
  getEnhancedWeeklyReportData: jest.fn(async () => null),
  getAvailableWeekSlugs: jest.fn(async () => []),
}));
jest.mock("../home-content", () => ({ HomeContent: () => null }));
jest.mock("../top-shorts-fallback", () => ({ TopShortsFallback: () => null }));
jest.mock("../browse-by-industry", () => ({ BrowseByIndustry: () => null }));
jest.mock("../trending-this-week", () => ({ TrendingThisWeek: () => null }));
jest.mock("../short-flow-narrative", () => ({ ShortFlowNarrative: () => null }));
jest.mock("../latest-from-blog", () => ({ LatestFromBlog: () => null }));
jest.mock("../latest-market-news", () => ({ LatestMarketNews: () => null }));
jest.mock("~/@/components/premium/premium-upsell-banner", () => ({
  PremiumUpsellBanner: () => null,
}));
jest.mock("~/@/components/home/homepage-faq", () => ({ HomepageFaq: () => null }));
jest.mock("~/@/components/news/masthead/featured-story", () => ({
  FeaturedStory: () => null,
}));
jest.mock("~/@/components/news/masthead/featured", () => ({ FEATURED: [] }));

import { getTopShortsData } from "~/app/actions/getTopShorts";
import { DatasetStructuredData } from "~/@/components/seo/enhanced-structured-data";
import Page from "../page";

const mockTopShorts = getTopShortsData as jest.Mock;

/** The first element of this component type in the page's own JSX. */
function findElement(node: ReactNode, type: unknown): ReactElement | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child as ReactNode, type);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement(node)) return undefined;
  if (node.type === type) return node;
  return findElement((node.props as { children?: ReactNode }).children, type);
}

async function homepageDataset(): Promise<Record<string, unknown>> {
  const dataset = findElement(await Page(), DatasetStructuredData);
  if (!dataset) throw new Error("the homepage renders no DatasetStructuredData");
  const { container } = render(dataset);
  const script = container.querySelector('script[type="application/ld+json"]');
  return JSON.parse(script?.innerHTML ?? "{}") as Record<string, unknown>;
}

describe("homepage Dataset JSON-LD", () => {
  beforeEach(() => mockTopShorts.mockReset());

  it("dates dateModified to the latest ASIC report in the top-shorts read", async () => {
    mockTopShorts.mockResolvedValue({
      timeSeries: [
        // Edge-read JSON carries RFC 3339 strings; Connect carries Timestamps.
        {
          productCode: "BOE",
          points: [
            { timestamp: "2026-10-14T00:00:00Z" },
            { timestamp: "2026-10-15T00:00:00Z" },
          ],
        },
        {
          productCode: "DRO",
          points: [{ timestamp: { seconds: BigInt(Date.UTC(2026, 9, 13) / 1000) } }],
        },
      ],
    });
    const json = await homepageDataset();
    expect(json.dateModified).toBe("2026-10-15T00:00:00.000Z");
  });

  it("omits dateModified when the read carries no dated point", async () => {
    mockTopShorts.mockResolvedValue(undefined);
    const json = await homepageDataset();
    expect(json).not.toHaveProperty("dateModified");
  });
});
