/// <reference types="jest" />

const mockWeeklyData = jest.fn();
const mockMonthlyData = jest.fn();
const mockNarrative = jest.fn();
const mockHighlights = jest.fn();
const mockReportsList = jest.fn();

jest.mock("~/app/actions/reports/getReportData", () => ({
  getWeeklyReportDataStrict: (...args: unknown[]) => mockWeeklyData(...args),
  getMonthlyReportDataStrict: (...args: unknown[]) => mockMonthlyData(...args),
  getEnhancedWeeklyReportDataStrict: (...args: unknown[]) => mockNarrative(...args),
  getStockFinancialHighlightsStrict: (...args: unknown[]) => mockHighlights(...args),
  getReportsListStrict: (...args: unknown[]) => mockReportsList(...args),
}));
jest.mock("next/navigation", () => ({
  ...jest.requireActual("next/navigation"),
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  permanentRedirect: (path: string) => { throw new Error(`NEXT_REDIRECT:${path}`); },
}));

import * as weekly from "../weekly/[slug]/page";
import * as monthly from "../monthly/[slug]/page";
import * as yearly from "../yearly/[slug]/page";

const weeklySlug = "10-most-shorted-asx-stocks-week-20-2026";
const props = (slug: string) => ({ params: Promise.resolve({ slug }) });
const narrative = {
  headline: "Published report",
  summary: "Real report summary",
  narrative: { openingHook: "Real narrative" },
  topShorted: [],
  risers: [],
  fallers: [],
  faqs: [],
  citations: [],
  industryBreakdown: [],
};
const emptyWeekly = {
  weekSlug: "2026-W20", startDate: "2026-05-11", endDate: "2026-05-15",
  dates: [], topStocks: [], totalStocksShorted: 0,
};
const emptyMonthly = {
  monthSlug: "2026-05", month: "May", year: "2026",
  dates: [], topStocks: [], totalStocksShorted: 0,
};

describe("report ISR generation", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockNarrative.mockResolvedValue(narrative);
    mockWeeklyData.mockResolvedValue(emptyWeekly);
    mockMonthlyData.mockResolvedValue(emptyMonthly);
    mockHighlights.mockResolvedValue({});
    mockReportsList.mockResolvedValue([]);
  });

  it.each([
    ["weekly", weekly], ["monthly", monthly], ["yearly", yearly],
  ])("generates %s archives on first request with a 24h safety interval", (_name, route) => {
    expect(route.generateStaticParams()).toEqual([]);
    expect(route.dynamicParams).toBe(true);
    expect(route.revalidate).toBe(86400);
  });

  it.each([
    ["weekly", weekly, weeklySlug],
    ["monthly", monthly, "2026-05"],
    ["yearly", yearly, "2025"],
  ])("never turns a %s narrative outage into a cached 404 or degraded page", async (_name, route, slug) => {
    const outage = new Error("narrative unavailable");
    mockNarrative.mockRejectedValue(outage);
    await expect(route.generateMetadata(props(slug))).rejects.toThrow(outage);
    await expect(route.default(props(slug))).rejects.toThrow(outage);
  });

  it.each([
    ["weekly", weekly, weeklySlug, mockWeeklyData],
    ["monthly", monthly, "2026-05", mockMonthlyData],
  ])("aborts %s generation when the market snapshot fails", async (_name, route, slug, mockData) => {
    mockData.mockRejectedValue(new Error("snapshot unavailable"));
    await expect(route.generateMetadata(props(slug))).rejects.toThrow("snapshot unavailable");
    await expect(route.default(props(slug))).rejects.toThrow("snapshot unavailable");
  });

  it.each([
    ["weekly", weekly, weeklySlug],
    ["monthly", monthly, "2026-05"],
    ["yearly", yearly, "2025"],
  ])("404s %s only after successful definitive absence", async (_name, route, slug) => {
    mockNarrative.mockResolvedValue(null);
    await expect(route.generateMetadata(props(slug))).rejects.toThrow("NEXT_NOT_FOUND");
    await expect(route.default(props(slug))).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it.each([
    ["weekly", weekly, weeklySlug],
    ["monthly", monthly, "2026-05"],
  ])("renders a published %s narrative while ASIC snapshots legitimately lag", async (_name, route, slug) => {
    await expect(route.generateMetadata(props(slug))).resolves.toHaveProperty("description");
    await expect(route.default(props(slug))).resolves.toBeTruthy();
  });

  it("aborts weekly generation when cached navigation cannot be loaded", async () => {
    mockReportsList.mockRejectedValue(new Error("archive unavailable"));
    await expect(weekly.default(props(weeklySlug))).rejects.toThrow("archive unavailable");
  });

  it("aborts weekly generation rather than caching empty failed financial enrichment", async () => {
    mockWeeklyData.mockResolvedValue({
      ...emptyWeekly,
      topStocks: [{ code: "BHP", name: "BHP", shortPercent: 2, industry: "Materials" }],
    });
    mockHighlights.mockRejectedValue(new Error("financials unavailable"));
    await expect(weekly.default(props(weeklySlug))).rejects.toThrow("financials unavailable");
  });

  it("retains the legacy weekly URL redirect before fetching data", async () => {
    await expect(weekly.generateMetadata(props("2026-W20"))).rejects.toThrow(
      "NEXT_REDIRECT:/reports/weekly/10-most-shorted-asx-stocks-week-20-2026",
    );
    expect(mockNarrative).not.toHaveBeenCalled();
  });

  it("rejects an invalid monthly period without querying the backend", async () => {
    await expect(monthly.generateMetadata(props("2026-13"))).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mockMonthlyData).not.toHaveBeenCalled();
  });
});
