/// <reference types="jest" />
import { beforeEach, describe, expect, it } from "@jest/globals";

/**
 * Templated titles stay inside the width Google shows: about 60 characters
 * before the root layout's " | Shorted", with the query leading. The
 * 2026-10-21 probe rendered /market/2026-10-15 at 77 characters, the stock
 * Company and Strategy tabs at 77 and 73, /seasonality at 77 and the monthly
 * reports at 70-86 (seo-review finding 14). One page of each template, through
 * its own generateMetadata, with the data its route reads mocked.
 */

jest.mock("@connectrpc/connect", () => ({ createClient: jest.fn(() => ({})) }));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("next/dynamic", () => () => () => null);
jest.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
jest.mock("~/app/actions/getStock", () => ({ getStock: jest.fn() }));
jest.mock("~/app/actions/getStockStrategyFit", () => ({
  getStockStrategyFit: jest.fn(async () => ({ inUniverse: true })),
}));
jest.mock("~/app/actions/market/getMarketByDate", () => ({
  ...jest.requireActual<object>("~/app/actions/market/getMarketByDate"),
  getMarketByDateStrict: jest.fn(),
}));
jest.mock("~/app/actions/reports/getReportData", () => ({
  getEnhancedWeeklyReportDataStrict: jest.fn(),
  getMonthlyReportDataStrict: jest.fn(),
}));

import { getStock } from "~/app/actions/getStock";
import { getMarketByDateStrict } from "~/app/actions/market/getMarketByDate";
import {
  getEnhancedWeeklyReportDataStrict,
  getMonthlyReportDataStrict,
} from "~/app/actions/reports/getReportData";
import { generateMetadata as companyMetadata } from "../shorts/[stockCode]/company/page";
import { generateMetadata as strategyMetadata } from "../shorts/[stockCode]/strategy/page";
import { generateMetadata as marketMetadata } from "../market/[date]/page";
import { generateMetadata as monthlyMetadata } from "../reports/monthly/[slug]/page";
import { metadata as seasonalityMetadata } from "../seasonality/page";

const mockStock = getStock as jest.Mock;

/** What the root template renders: `%s | Shorted`. */
const rendered = (title: unknown) => `${String(title)} | Shorted`;

function expectWithinBudget(title: unknown) {
  expect(typeof title).toBe("string");
  expect(String(title).length).toBeLessThanOrEqual(60);
  expect(rendered(title).length).toBeLessThanOrEqual(70);
}

const stockParams = (stockCode: string) => ({ params: Promise.resolve({ stockCode }) });

describe("templated titles", () => {
  beforeEach(() => {
    mockStock.mockReset();
    mockStock.mockResolvedValue({
      name: "DRONESHIELD LIMITED",
      industry: "Capital Goods",
      percentageShorted: 15.07,
    });
  });

  it("leads the Company tab with the code and its topic", async () => {
    const meta = await companyMetadata(stockParams("dro"));
    expect(meta.title).toBe("DRO Company Profile: Directors & Insiders | Droneshield");
    expectWithinBudget(meta.title);
  });

  it("leads the Strategy tab with the code and the rules it checks", async () => {
    const meta = await strategyMetadata(stockParams("dro"));
    expect(meta.title).toBe("DRO Strategy Fit: Breakout, CANSLIM & Trend | Droneshield");
    expectWithinBudget(meta.title);
  });

  it("leaves a company name that does not fit to the description", async () => {
    mockStock.mockResolvedValue({
      name: "COMMONWEALTH BANK OF AUSTRALIA. ORDINARY",
      industry: "Banks",
      percentageShorted: 0.6,
    });
    const meta = await strategyMetadata(stockParams("cba"));
    expect(meta.title).toBe("CBA Strategy Fit: Breakout, CANSLIM & Trend");
    expect(String(meta.description)).toContain("Commonwealth Bank of Australia");
    expectWithinBudget(meta.title);
  });

  it("leads a market snapshot with the date, without the weekday", async () => {
    (getMarketByDateStrict as jest.Mock).mockResolvedValue({
      stocks: [{ productCode: "DRO", percentageShorted: 15.07 }],
      totalCount: 1,
    });
    // The longest month name.
    const meta = await marketMetadata({ params: Promise.resolve({ date: "2026-09-30" }) });
    expect(meta.title).toBe("ASX Short Positions on 30 September 2026: Daily ASIC Report");
    expect(String(meta.description)).toContain("Wednesday 30 September 2026");
    expectWithinBudget(meta.title);
  });

  it("titles a monthly report by its series, and its social card by the headline", async () => {
    const headline = "Uranium shorts hit the eject button — but burritos and lithium get leaned on";
    (getEnhancedWeeklyReportDataStrict as jest.Mock).mockResolvedValue({
      headline,
      summary: "Summary.",
    });
    (getMonthlyReportDataStrict as jest.Mock).mockResolvedValue({
      topStocks: [{ productCode: "BOE" }],
    });
    const meta = await monthlyMetadata({ params: Promise.resolve({ slug: "2025-09" }) });
    expect(meta.title).toBe("ASX Short Selling Report: September 2025");
    expect(meta.openGraph?.title).toBe(headline);
    expect(meta.twitter?.title).toBe(headline);
    expectWithinBudget(meta.title);
  });

  it("keeps /seasonality inside the budget", () => {
    expect(seasonalityMetadata.title).toBe(
      "ASX Short Interest Seasonality: Earnings, Dividends & EOFY",
    );
    expectWithinBudget(seasonalityMetadata.title);
  });
});
