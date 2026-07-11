/**
 * Tests for the reports archive action (getReportsList) and the enhanced
 * weekly report mapping of the new snapshot fields.
 *
 * Follows the existing convention (see getTopShorts-cache.test.ts): the
 * Connect transport/client and generated proto module are mocked so no
 * protobuf machinery is exercised.
 */

// unstable_cache needs the Next.js request runtime — pass through in tests
jest.mock("next/cache", () => ({
  unstable_cache: (fn: (...args: unknown[]) => unknown) => fn,
}));

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(),
}));

const mockListReports = jest.fn();
const mockGetWeeklyReport = jest.fn();

jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    listReports: mockListReports,
    getWeeklyReport: mockGetWeeklyReport,
  })),
}));

jest.mock("~/gen/shorts/v1alpha1/shorts_pb", () => ({
  ShortedStocksService: {},
}));

import {
  getReportsList,
  getEnhancedWeeklyReportData,
} from "../getReportData";

describe("getReportsList", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("maps ReportListItem fields including logo strips", async () => {
    mockListReports.mockResolvedValue({
      reports: [
        {
          slug: "2026-W20",
          reportType: "weekly",
          headline: "Lithium shorts surge",
          summary: "PLS leads the board [ref-1]",
          reportDate: "2026-05-15",
          maxShortPct: 14.2,
          maxShortCode: "PLS",
          totalStocksShorted: 612,
          qualityScore: 0.92,
          topCodes: ["PLS", "SYR", "IEL"],
          topLogoUrls: ["https://logos/pls.png", "", "https://logos/iel.png"],
        },
      ],
    });

    const result = await getReportsList("weekly", 12);

    expect(mockListReports).toHaveBeenCalledWith({
      reportType: "weekly",
      limit: 12,
    });
    expect(result).toEqual([
      {
        slug: "2026-W20",
        reportType: "weekly",
        headline: "Lithium shorts surge",
        summary: "PLS leads the board [ref-1]",
        reportDate: "2026-05-15",
        maxShortPct: 14.2,
        maxShortCode: "PLS",
        totalStocksShorted: 612,
        qualityScore: 0.92,
        topCodes: ["PLS", "SYR", "IEL"],
        topLogoUrls: ["https://logos/pls.png", "", "https://logos/iel.png"],
      },
    ]);
  });

  it("defaults missing repeated fields to empty arrays", async () => {
    mockListReports.mockResolvedValue({
      reports: [
        {
          slug: "2025",
          reportType: "yearly",
          headline: "",
          summary: "",
          reportDate: "",
          maxShortPct: 0,
          maxShortCode: "",
          totalStocksShorted: 0,
          qualityScore: 0,
          topCodes: undefined,
          topLogoUrls: undefined,
        },
      ],
    });

    const result = await getReportsList();
    expect(result[0]!.topCodes).toEqual([]);
    expect(result[0]!.topLogoUrls).toEqual([]);
  });

  it("returns an empty array when the RPC fails (graceful index fallback)", async () => {
    const consoleSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    mockListReports.mockRejectedValue(new Error("unavailable"));

    const result = await getReportsList("", 60);

    expect(result).toEqual([]);
    consoleSpy.mockRestore();
  });
});

describe("getEnhancedWeeklyReportData snapshot-field mapping", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const baseResponse = {
    headline: "Big week for shorts",
    summary: "Summary",
    narrative: {
      openingHook: "Hook",
      topAnalysis: "",
      moversAnalysis: "",
      industryAnalysis: "",
      outlook: "",
    },
    faqs: [],
    citations: [],
    qualityScore: 0.8,
  };

  it("maps the new per-stock, mover, industry and market-stat fields", async () => {
    mockGetWeeklyReport.mockResolvedValue({
      ...baseResponse,
      topShorted: [
        {
          rank: 1,
          code: "PLS",
          name: "Pilbara Minerals",
          shortPct: 14.2,
          wowChange: 0.6,
          daysToCover: 8.4,
          isNewEntrant: true,
          industry: "Materials",
          history: [12.1, 13.0, 14.2],
          logoUrl: "https://logos/pls.png",
        },
      ],
      risers: [
        {
          code: "SYR",
          name: "Syrah Resources",
          currentPct: 9.1,
          previousPct: 6.3,
          change: 2.8,
          daysToCover: 4.1,
          zScore: 2.8,
          streakWeeks: 4,
          industry: "Materials",
          history: [5.5, 6.3, 9.1],
          logoUrl: "https://logos/syr.png",
          significance: 0.91,
        },
      ],
      fallers: [],
      industryBreakdown: [
        {
          industry: "Materials",
          avgShortPct: 6.4,
          wowChange: 0.3,
          stockCount: 18,
          topStockCode: "PLS",
          topStockPct: 14.2,
        },
      ],
      marketStats: {
        totalStocksShorted: 612,
        avgShortPct: 2.1,
        maxShortPct: 14.2,
        maxShortCode: "PLS",
        wowAvgChange: 0.05,
        medianShortPct: 1.4,
        stocksAbove10pct: 11,
        stocksAbove5pct: 63,
        riserCount: 412,
        fallerCount: 508,
      },
    });

    const result = await getEnhancedWeeklyReportData("2026-W20");

    expect(result).not.toBeNull();
    expect(result!.topShorted[0]).toMatchObject({
      daysToCover: 8.4,
      isNewEntrant: true,
      industry: "Materials",
      history: [12.1, 13.0, 14.2],
      logoUrl: "https://logos/pls.png",
    });
    expect(result!.risers[0]).toMatchObject({
      daysToCover: 4.1,
      zScore: 2.8,
      streakWeeks: 4,
      history: [5.5, 6.3, 9.1],
      logoUrl: "https://logos/syr.png",
      significance: 0.91,
    });
    expect(result!.industryBreakdown).toEqual([
      {
        industry: "Materials",
        avgShortPct: 6.4,
        wowChange: 0.3,
        stockCount: 18,
        topStockCode: "PLS",
        topStockPct: 14.2,
      },
    ]);
    expect(result!.marketStats).toMatchObject({
      medianShortPct: 1.4,
      stocksAbove10Pct: 11,
      stocksAbove5Pct: 63,
      riserCount: 412,
      fallerCount: 508,
    });
  });

  it("degrades gracefully for old reports lacking snapshot fields", async () => {
    mockGetWeeklyReport.mockResolvedValue({
      ...baseResponse,
      topShorted: [
        { rank: 1, code: "IEL", name: "IDP Education", shortPct: 11.0, wowChange: -0.2 },
      ],
      risers: [
        { code: "APX", name: "Appen", currentPct: 5.0, previousPct: 4.0, change: 1.0 },
      ],
      fallers: [],
      industryBreakdown: undefined,
      marketStats: {
        totalStocksShorted: 600,
        avgShortPct: 2.0,
        maxShortPct: 11.0,
        maxShortCode: "IEL",
        wowAvgChange: -0.01,
      },
    });

    const result = await getEnhancedWeeklyReportData("2024-W10");

    expect(result!.topShorted[0]).toMatchObject({
      daysToCover: 0,
      isNewEntrant: false,
      industry: "",
      history: [],
      logoUrl: "",
    });
    expect(result!.risers[0]).toMatchObject({
      daysToCover: 0,
      zScore: 0,
      streakWeeks: 0,
      history: [],
      logoUrl: "",
      significance: 0,
    });
    expect(result!.industryBreakdown).toEqual([]);
    expect(result!.marketStats).toMatchObject({
      medianShortPct: 0,
      stocksAbove10Pct: 0,
      stocksAbove5Pct: 0,
      riserCount: 0,
      fallerCount: 0,
    });
  });
});
