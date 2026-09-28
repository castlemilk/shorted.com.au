import type {
  StockFundamentals,
  StockFundamentalsGrowth,
  StockFundamentalsPeriod,
  StockFundamentalsQuality,
} from "~/app/actions/getStockFundamentals";

// Plain fundamentals fixtures for the stock page tests: the SHAPE the one
// mapper (getStockFundamentals.ts) produces, so cards are tested against the
// same data the page passes them.

export function period(
  overrides: Partial<StockFundamentalsPeriod> &
    Pick<StockFundamentalsPeriod, "periodType" | "periodEnd">,
): StockFundamentalsPeriod {
  return {
    fiscalYear: null,
    currency: "AUD",
    source: "yahoo-timeseries",
    fetchedAt: "2026-09-27T20:00:00Z",
    revenue: null,
    netIncome: null,
    epsBasic: null,
    epsDiluted: null,
    operatingCashFlow: null,
    sharesOutstanding: null,
    freeCashFlow: null,
    grossProfit: null,
    operatingIncome: null,
    ebitda: null,
    normalizedEbitda: null,
    ebit: null,
    interestExpense: null,
    pretaxIncome: null,
    taxProvision: null,
    netInterestIncome: null,
    capitalExpenditure: null,
    dividendsPaid: null,
    shareBuybacks: null,
    totalAssets: null,
    totalLiabilities: null,
    totalEquity: null,
    cashAndEquivalents: null,
    totalDebt: null,
    capitalLeaseObligations: null,
    netDebt: null,
    currentAssets: null,
    currentLiabilities: null,
    fieldSources: {},
    sourceDocumentUrl: "",
    sourceDocumentDate: "",
    ...overrides,
  };
}

export function growth(
  overrides: Partial<StockFundamentalsGrowth> = {},
): StockFundamentalsGrowth {
  return {
    basisPeriodType: "annual",
    latestPeriodEnd: "2026-06-30",
    revenueBasisPeriodType: "annual",
    revenueYoyPct: 8.4,
    revenueYoyPriorPct: null,
    epsYoyPct: 12.1,
    epsYoyPriorPct: null,
    netIncomePositive: true,
    periodsAvailable: 4,
    revenueTtm: null,
    netIncomeTtm: null,
    epsTtm: null,
    revenueHalfYoyPct: null,
    epsHalfYoyPct: null,
    halfLatestPeriodEnd: "",
    revenueBasisSource: "vendor",
    epsBasisSource: "vendor",
    fetchedAt: "2026-09-27T20:00:00Z",
    revenueLatestPeriodEnd: "2026-06-30",
    revenuePriorPeriodEnd: "2025-06-30",
    ...overrides,
  };
}

export function quality(
  overrides: Partial<StockFundamentalsQuality> = {},
): StockFundamentalsQuality {
  return {
    basisPeriodType: "annual",
    basisPeriodEnd: "2026-06-30",
    currency: "AUD",
    balancePeriodEnd: "2026-06-30",
    balanceCurrency: "AUD",
    balanceLagMonths: 0,
    source: "yahoo-timeseries",
    grossMarginPct: 34.2,
    operatingMarginPct: 12.5,
    netMarginPct: 9.1,
    fcfMarginPct: 7.4,
    fcfConversion: 0.81,
    roePct: 18.4,
    roaPct: 7.2,
    netDebt: 1_250_000_000,
    netDebtToEbitda: 1.3,
    netDebtToEquity: 0.4,
    currentRatio: 1.42,
    interestCover: 9.8,
    payoutRatioPct: 62.5,
    isFinancial: false,
    isProperty: false,
    operatingCashFlowDerived: false,
    marketCap: 44_300_000_000,
    peRatio: 21.4,
    priceToBook: 3.1,
    priceAsOf: "2026-09-26",
    sharesAsOf: "2026-06-30",
    peEpsPeriodEnd: "2026-06-30",
    peEpsBasis: "diluted",
    valuationNote: "",
    notMeaningful: [],
    ...overrides,
  };
}

/** A June-balance-date AUD reporter with four years, a TTM, halves and snapshots. */
export function wesLike(): StockFundamentals {
  const annual = [2026, 2025, 2024, 2023].map((year, i) =>
    period({
      periodType: "annual",
      periodEnd: `${year}-06-30`,
      fiscalYear: year,
      revenue: 44_000_000_000 - i * 1_000_000_000,
      grossProfit: 15_000_000_000 - i * 300_000_000,
      operatingIncome: 5_500_000_000 - i * 100_000_000,
      ebitda: 6_900_000_000,
      ebit: 5_400_000_000,
      interestExpense: 400_000_000,
      pretaxIncome: 5_000_000_000,
      taxProvision: 1_500_000_000,
      netIncome: 2_900_000_000 - i * 100_000_000,
      epsBasic: 2.55 - i * 0.1,
      epsDiluted: 2.54 - i * 0.1,
      sharesOutstanding: 1_134_000_000,
      operatingCashFlow: 4_600_000_000,
      capitalExpenditure: -1_100_000_000,
      freeCashFlow: 3_500_000_000,
      dividendsPaid: -2_200_000_000,
      totalAssets: 27_000_000_000,
      totalLiabilities: 18_000_000_000,
      totalEquity: 9_000_000_000,
      cashAndEquivalents: 1_000_000_000,
      totalDebt: 6_000_000_000,
      capitalLeaseObligations: 3_800_000_000,
      netDebt: 1_200_000_000,
      currentAssets: 9_000_000_000,
      currentLiabilities: 7_000_000_000,
    }),
  );
  return {
    stockCode: "WES",
    periods: [
      period({
        periodType: "ttm",
        periodEnd: "2026-06-30",
        revenue: 44_000_000_000,
        netIncome: 2_900_000_000,
      }),
      ...annual,
    ],
    growth: growth(),
    quality: quality(),
    coverage: {
      status: "covered",
      lastAttemptAt: "2026-09-27T15:10:00Z",
      lastSuccessAt: "2026-09-27T15:10:00Z",
      sources: ["yahoo-timeseries"],
    },
    latestFiling: null,
  };
}

/** Every numeric field populated, so the fixture is as heavy as the wire allows. */
export function fullRow(
  periodType: string,
  periodEnd: string,
  seed: number,
  extra: Partial<StockFundamentalsPeriod> = {},
): StockFundamentalsPeriod {
  const big = (n: number) => 1_234_567_890_123 + seed * 1_000_003 + n * 7_919;
  const flow = periodType !== "quarter";
  return period({
    periodType,
    periodEnd,
    fiscalYear: periodType === "annual" ? Number(periodEnd.slice(0, 4)) : null,
    currency: "USD",
    revenue: flow ? big(1) : null,
    netIncome: flow ? big(2) : null,
    epsBasic: flow ? 3.456789 + seed : null,
    epsDiluted: flow ? 3.401234 + seed : null,
    operatingCashFlow: flow ? big(3) : null,
    sharesOutstanding: 5_074_123_456 + seed,
    freeCashFlow: flow ? big(4) : null,
    grossProfit: flow ? big(5) : null,
    operatingIncome: flow ? big(6) : null,
    ebitda: flow ? big(7) : null,
    normalizedEbitda: flow ? big(8) : null,
    ebit: flow ? big(9) : null,
    interestExpense: flow ? big(10) : null,
    pretaxIncome: flow ? big(11) : null,
    taxProvision: flow ? big(12) : null,
    netInterestIncome: flow ? -big(13) : null,
    capitalExpenditure: flow ? -big(14) : null,
    dividendsPaid: flow ? -big(15) : null,
    shareBuybacks: flow ? -big(16) : null,
    totalAssets: big(17),
    totalLiabilities: big(18),
    totalEquity: big(19),
    cashAndEquivalents: big(20),
    totalDebt: big(21),
    capitalLeaseObligations: big(22),
    netDebt: big(23),
    currentAssets: big(24),
    currentLiabilities: big(25),
    fieldSources: {
      operating_cash_flow: "derived:fcf-minus-capex",
      revenue: "markit-key-statistics",
    },
    ...extra,
  });
}

/** 40 periods, every field set: 12 annual, 12 TTM, 8 half, 8 quarter. */
export function fortyPeriods(): StockFundamentals {
  const periods: StockFundamentalsPeriod[] = [];
  for (let i = 0; i < 12; i++) {
    const year = 2026 - i;
    periods.push(fullRow("annual", `${year}-06-30`, i));
    periods.push(fullRow("ttm", `${year}-12-31`, i + 20));
  }
  for (let i = 0; i < 8; i++) {
    const year = 2025 - i;
    periods.push(
      fullRow("half", `${year}-12-31`, i + 40, {
        source: "asx-filing-extraction",
        sourceDocumentUrl: `https://www.asx.com.au/asxpdf/${year}0220/pdf/0123456789abcdef.pdf`,
        sourceDocumentDate: `${year + 1}-02-20`,
      }),
    );
    periods.push(fullRow("quarter", `${year}-12-31`, i + 60));
  }
  return { ...wesLike(), stockCode: "BHP", periods };
}
