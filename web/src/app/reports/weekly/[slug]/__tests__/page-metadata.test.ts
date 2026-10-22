/// <reference types="jest" />
import { beforeEach, describe, expect, it } from "@jest/globals";

/**
 * The weekly report's robots key. Next 14.2 merges metadata with `for (key in
 * source)`, so an own `robots: undefined` replaces the root layout's robots
 * (and its googleBot max-image-preview / max-snippet directives) with nothing:
 * every published weekly report emitted no robots meta (2026-10-21).
 * Indexable means no key; a report whose narrative has not landed is noindexed.
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  permanentRedirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));
jest.mock("~/app/actions/reports/getReportData", () => ({
  getWeeklyReportDataStrict: jest.fn(),
  getEnhancedWeeklyReportDataStrict: jest.fn(),
  getStockFinancialHighlightsStrict: jest.fn(),
  getReportsListStrict: jest.fn(),
}));

import {
  getEnhancedWeeklyReportDataStrict,
  getWeeklyReportDataStrict,
} from "~/app/actions/reports/getReportData";
import { generateMetadata } from "../page";

const mockEnhanced = getEnhancedWeeklyReportDataStrict as jest.Mock;
const mockData = getWeeklyReportDataStrict as jest.Mock;

const params = Promise.resolve({ slug: "10-most-shorted-asx-stocks-week-42-2026" });

describe("weekly report metadata", () => {
  beforeEach(() => {
    mockData.mockResolvedValue({ topStocks: [{ productCode: "DRO" }] });
  });

  it("sets no robots key on a report with its narrative", async () => {
    mockEnhanced.mockResolvedValue({ headline: "Shorts pile into BOE", summary: "s" });
    const meta = await generateMetadata({ params });
    expect(Object.keys(meta)).not.toContain("robots");
    expect(meta.title).toBe("The 10 Most Shorted ASX Stocks — Week 42, 2026");
  });

  it("noindexes a report whose narrative has not landed", async () => {
    mockEnhanced.mockResolvedValue(null);
    const meta = await generateMetadata({ params });
    expect(meta.robots).toEqual({
      index: false,
      follow: true,
      googleBot: { index: false, follow: true },
    });
  });
});
