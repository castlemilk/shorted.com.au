/// <reference types="jest" />
import { beforeEach, describe, expect, it } from "@jest/globals";

/**
 * The monthly report's robots key. Next 14.2 merges metadata with `for (key in
 * source)`, so an own `robots: undefined` replaces the root layout's robots
 * (and its googleBot max-image-preview / max-snippet directives) with nothing:
 * every published monthly report emitted no robots meta (2026-10-21).
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
}));
jest.mock("~/app/actions/reports/getReportData", () => ({
  getMonthlyReportDataStrict: jest.fn(),
  getEnhancedWeeklyReportDataStrict: jest.fn(),
}));

import {
  getEnhancedWeeklyReportDataStrict,
  getMonthlyReportDataStrict,
} from "~/app/actions/reports/getReportData";
import { generateMetadata } from "../page";

const mockEnhanced = getEnhancedWeeklyReportDataStrict as jest.Mock;
const mockData = getMonthlyReportDataStrict as jest.Mock;

const params = Promise.resolve({ slug: "2026-09" });

describe("monthly report metadata", () => {
  beforeEach(() => {
    mockData.mockResolvedValue({ topStocks: [{ productCode: "DRO" }] });
  });

  it("sets no robots key on a report with its narrative", async () => {
    mockEnhanced.mockResolvedValue({
      headline: "BAP shorts hit the eject button — while BOE and IPX crash the top 10",
      summary: "The biggest tell in September wasn't at the top.",
    });
    const meta = await generateMetadata({ params });
    expect(Object.keys(meta)).not.toContain("robots");
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
