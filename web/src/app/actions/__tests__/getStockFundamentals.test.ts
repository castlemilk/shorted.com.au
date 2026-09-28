import { describe, it, expect } from "@jest/globals";
import { create } from "@bufbuild/protobuf";
import { TextEncoder, TextDecoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}
import {
  FundamentalsGrowthSchema,
  FundamentalsPeriodSchema,
  GetStockFundamentalsResponseSchema,
} from "~/gen/shorts/v1alpha1/stock_pb";

const mockGetStockFundamentals = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStockFundamentals: (...args: unknown[]) => mockGetStockFundamentals(...args),
  })),
}));
const mockUnstableCache = jest.fn(
  (loader: () => Promise<unknown>, _key?: string[], _opts?: unknown) => loader,
);
jest.mock("next/cache", () => ({
  unstable_cache: (loader: () => Promise<unknown>, key?: string[], opts?: unknown) =>
    mockUnstableCache(loader, key, opts),
}));

import {
  STOCK_FUNDAMENTALS_LIMIT,
  getStockFundamentals,
  mapGrowth,
  mapStockFundamentals,
} from "../getStockFundamentals";
import { shapeStatements } from "~/@/components/stocks/statements-shape";

/** A current-API response: every period type, quality, coverage, filing. */
function currentResponse() {
  return create(GetStockFundamentalsResponseSchema, {
    stockCode: "BHP",
    periods: [
      {
        periodType: "annual",
        periodEnd: "2026-06-30",
        fiscalYear: 2026,
        currency: "usd",
        revenue: 55_657_000_000,
        hasRevenue: true,
        netIncome: 9_019_000_000,
        hasNetIncome: true,
        // Present as 0 with no flag: not held, so null rather than 0.
        epsDiluted: 0,
        hasEpsDiluted: false,
        epsBasic: 1.78,
        hasEpsBasic: true,
        operatingCashFlow: 18_000_000_000,
        hasOperatingCashFlow: true,
        totalEquity: 49_000_000_000,
        hasTotalEquity: true,
        netDebt: 0,
        hasNetDebt: true, // a measured zero survives
        capitalExpenditure: -9_300_000_000,
        hasCapitalExpenditure: true,
        source: "yahoo-timeseries",
        fetchedAt: "2026-09-27T20:00:00Z",
        fieldSources: { operating_cash_flow: "derived:fcf-minus-capex" },
      },
      {
        periodType: "quarter",
        periodEnd: "2025-12-31",
        currency: "USD",
        totalAssets: 108_000_000_000,
        hasTotalAssets: true,
        source: "yahoo-timeseries",
      },
      {
        periodType: "half",
        periodEnd: "2025-12-31",
        currency: "USD",
        revenue: 27_000_000_000,
        hasRevenue: true,
        source: "asx-filing-extraction",
        sourceDocumentUrl: "https://www.asx.com.au/asxpdf/20260217/pdf/x.pdf",
        sourceDocumentDate: "2026-02-17",
      },
    ],
    growth: {
      basisPeriodType: "ttm",
      latestPeriodEnd: "2025-12-31",
      revenueBasisPeriodType: "ttm",
      revenueYoyPct: 4.2,
      hasRevenueYoy: true,
      epsYoyPct: 0,
      hasEpsYoy: false,
      revenueBasisSource: "vendor",
      epsBasisSource: "filing",
      fetchedAt: "2026-09-27T20:00:00Z",
      revenueLatestPeriodEnd: "2025-12-31",
      revenuePriorPeriodEnd: "2024-12-31",
    },
    hasGrowth: true,
    quality: {
      basisPeriodType: "annual",
      basisPeriodEnd: "2026-06-30",
      currency: "USD",
      balancePeriodEnd: "2026-06-30",
      balanceCurrency: "USD",
      balanceLagMonths: 0,
      netMarginPct: 16.2,
      hasNetMarginPct: true,
      roePct: 0,
      hasRoePct: false,
      peRatio: 0,
      hasPeRatio: false,
      valuationNote: "non-aud",
      notMeaningful: [],
      isFinancial: false,
      source: "yahoo-timeseries",
    },
    hasQuality: true,
    coverage: {
      status: "covered",
      lastAttemptAt: "2026-09-27T15:10:00Z",
      lastSuccessAt: "2026-09-27T15:10:00Z",
      sources: ["yahoo-timeseries", "asx-filing-extraction"],
    },
    latestFiling: {
      reportUrl: "https://www.asx.com.au/asxpdf/20260819/pdf/r.pdf",
      reportTitle: "Appendix 4E",
      reportDate: "2026-08-19",
      periodEnd: "2026-06-30",
      periodType: "annual",
      digest: "Underlying EBITDA fell on iron ore prices.",
      digestConfidence: 0.82,
    },
    hasLatestFiling: true,
  });
}

describe("mapStockFundamentals (the one mapper)", () => {
  it("maps every period type and field, honouring has_* flags", () => {
    const mapped = mapStockFundamentals("BHP", currentResponse());
    expect(mapped.periods.map((p) => `${p.periodType}:${p.periodEnd}`)).toEqual([
      "annual:2026-06-30",
      "quarter:2025-12-31",
      "half:2025-12-31",
    ]);
    const annual = mapped.periods[0]!;
    expect(annual).toMatchObject({
      fiscalYear: 2026,
      currency: "USD",
      revenue: 55_657_000_000,
      epsDiluted: null,
      epsBasic: 1.78,
      netDebt: 0,
      capitalExpenditure: -9_300_000_000,
      totalEquity: 49_000_000_000,
      grossProfit: null,
      source: "yahoo-timeseries",
      fetchedAt: "2026-09-27T20:00:00Z",
      fieldSources: { operating_cash_flow: "derived:fcf-minus-capex" },
      sourceDocumentUrl: "",
    });
    expect(mapped.periods[2]).toMatchObject({
      source: "asx-filing-extraction",
      sourceDocumentUrl: "https://www.asx.com.au/asxpdf/20260217/pdf/x.pdf",
      sourceDocumentDate: "2026-02-17",
    });
    expect(mapped.growth).toMatchObject({
      basisPeriodType: "ttm",
      revenueYoyPct: 4.2,
      epsYoyPct: null,
      revenueBasisSource: "vendor",
      epsBasisSource: "filing",
      revenueLatestPeriodEnd: "2025-12-31",
      revenuePriorPeriodEnd: "2024-12-31",
    });
    expect(mapped.quality).toMatchObject({
      currency: "USD",
      netMarginPct: 16.2,
      roePct: null,
      peRatio: null,
      valuationNote: "non-aud",
      balanceLagMonths: 0,
    });
    expect(mapped.coverage).toEqual({
      status: "covered",
      lastAttemptAt: "2026-09-27T15:10:00Z",
      lastSuccessAt: "2026-09-27T15:10:00Z",
      sources: ["yahoo-timeseries", "asx-filing-extraction"],
    });
    expect(mapped.latestFiling).toMatchObject({
      reportTitle: "Appendix 4E",
      digest: "Underlying EBITDA fell on iron ore prices.",
    });
  });

  it("maps an older API's response (no quality, coverage or filing) to unknown, never to an empty state", () => {
    // Only the fields the pre-000132 proto had.
    const old = create(GetStockFundamentalsResponseSchema, {
      stockCode: "BHP",
      periods: [
        create(FundamentalsPeriodSchema, {
          periodType: "annual",
          periodEnd: "2025-06-30",
          currency: "USD",
          revenue: 51_000_000_000,
          hasRevenue: true,
        }),
      ],
      growth: create(FundamentalsGrowthSchema, {
        basisPeriodType: "annual",
        revenueYoyPct: 3,
        hasRevenueYoy: true,
      }),
      hasGrowth: true,
    });
    const mapped = mapStockFundamentals("BHP", old);
    expect(mapped.quality).toBeNull();
    expect(mapped.latestFiling).toBeNull();
    expect(mapped.coverage.status).toBe("unknown");
    expect(mapped.growth?.revenueBasisPeriodType).toBe("");
    expect(mapped.growth?.revenueBasisSource).toBe("");
    expect(mapped.periods[0]?.fieldSources).toEqual({});
    expect(mapped.periods[0]?.totalEquity).toBeNull();
  });

  it("an unknown coverage status is unknown too", () => {
    const response = currentResponse();
    response.coverage!.status = "reticulating";
    expect(mapStockFundamentals("BHP", response).coverage.status).toBe("unknown");
  });

  it("a 40-period response maps and shapes within the island's 8192-byte budget", () => {
    const periods = [];
    for (let i = 0; i < 40; i++) {
      const type = ["annual", "ttm", "half", "quarter"][i % 4]!;
      const year = 2026 - Math.floor(i / 4);
      const end = type === "annual" || type === "quarter" ? `${year}-06-30` : `${year}-12-31`;
      const n = (k: number) => 98_765_432_109 + i * 1_001 + k;
      periods.push(
        create(FundamentalsPeriodSchema, {
          periodType: type,
          periodEnd: end,
          currency: "USD",
          ...(type === "quarter"
            ? {}
            : {
                revenue: n(1), hasRevenue: true,
                netIncome: n(2), hasNetIncome: true,
                epsBasic: 1.2345, hasEpsBasic: true,
                epsDiluted: 1.2301, hasEpsDiluted: true,
                grossProfit: n(3), hasGrossProfit: true,
                operatingIncome: n(4), hasOperatingIncome: true,
                ebitda: n(5), hasEbitda: true,
                ebit: n(6), hasEbit: true,
                interestExpense: n(7), hasInterestExpense: true,
                pretaxIncome: n(8), hasPretaxIncome: true,
                taxProvision: n(9), hasTaxProvision: true,
                operatingCashFlow: n(10), hasOperatingCashFlow: true,
                capitalExpenditure: -n(11), hasCapitalExpenditure: true,
                freeCashFlow: n(12), hasFreeCashFlow: true,
                dividendsPaid: -n(13), hasDividendsPaid: true,
                shareBuybacks: -n(14), hasShareBuybacks: true,
              }),
          sharesOutstanding: 5_070_000_000, hasSharesOutstanding: true,
          totalAssets: n(15), hasTotalAssets: true,
          totalLiabilities: n(16), hasTotalLiabilities: true,
          totalEquity: n(17), hasTotalEquity: true,
          cashAndEquivalents: n(18), hasCashAndEquivalents: true,
          totalDebt: n(19), hasTotalDebt: true,
          capitalLeaseObligations: n(20), hasCapitalLeaseObligations: true,
          netDebt: n(21), hasNetDebt: true,
          currentAssets: n(22), hasCurrentAssets: true,
          currentLiabilities: n(23), hasCurrentLiabilities: true,
          source: type === "half" ? "asx-filing-extraction" : "yahoo-timeseries",
          fieldSources: { operating_cash_flow: "derived:fcf-minus-capex" },
        }),
      );
    }
    const mapped = mapStockFundamentals(
      "BHP",
      create(GetStockFundamentalsResponseSchema, { stockCode: "BHP", periods, hasGrowth: false }),
    );
    expect(mapped.periods).toHaveLength(STOCK_FUNDAMENTALS_LIMIT);
    const props = shapeStatements(mapped)!;
    expect(props.columns.length).toBeLessThanOrEqual(9);
    expect(JSON.stringify(props).length).toBeLessThanOrEqual(8192);
  });
});

describe("getStockFundamentals", () => {
  beforeEach(() => {
    mockGetStockFundamentals.mockReset();
    mockUnstableCache.mockClear();
  });

  it("requests every period type (limit 40) under cache key v3 with the fundamentals tag", async () => {
    mockGetStockFundamentals.mockResolvedValue(currentResponse());
    const result = await getStockFundamentals("bhp");
    expect(mockGetStockFundamentals).toHaveBeenCalledWith({
      stockCode: "BHP",
      periodType: "",
      limit: 40,
    });
    const [, key, opts] = mockUnstableCache.mock.calls[0]!;
    expect(key).toEqual(["stock-fundamentals", "BHP", "v3"]);
    expect((opts as { tags: string[] }).tags).toEqual(
      expect.arrayContaining(["shorts-data", "stock-page:fundamentals:bhp", "fundamentals"]),
    );
    expect(result?.coverage.status).toBe("covered");
  });

  it("throws inside the cache on failure (never cached) and degrades to null outside it", async () => {
    const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => undefined);
    mockGetStockFundamentals.mockRejectedValue(new Error("unavailable"));
    await expect(getStockFundamentals("ZZZ")).resolves.toBeNull();
    const [loader] = mockUnstableCache.mock.calls[0]!;
    await expect(loader()).rejects.toThrow("unavailable");
    consoleSpy.mockRestore();
  });
});

describe("mapGrowth", () => {
  it("returns null without a growth row", () => {
    expect(mapGrowth(undefined, true)).toBeNull();
    expect(mapGrowth(create(FundamentalsGrowthSchema, {}), false)).toBeNull();
  });

  it("carries the half basis and half-on-half figures, honouring has_* flags", () => {
    const g = mapGrowth(
      create(FundamentalsGrowthSchema, {
        basisPeriodType: "half",
        revenueBasisPeriodType: "half",
        revenueYoyPct: 22,
        hasRevenueYoy: true,
        epsYoyPct: 31,
        hasEpsYoy: true,
        revenueHalfYoyPct: 22,
        hasRevenueHalfYoy: true,
        epsHalfYoyPct: 0,
        hasEpsHalfYoy: false,
        halfLatestPeriodEnd: "2025-12-31",
      }),
      true,
    );
    expect(g).toMatchObject({
      basisPeriodType: "half",
      revenueBasisPeriodType: "half",
      revenueYoyPct: 22,
      epsYoyPct: 31,
      revenueHalfYoyPct: 22,
      epsHalfYoyPct: null,
      halfLatestPeriodEnd: "2025-12-31",
      revenueYoyPriorPct: null,
      revenueBasisSource: "",
    });
  });
});
