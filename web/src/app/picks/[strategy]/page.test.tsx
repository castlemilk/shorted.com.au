import { render, screen, within } from "@testing-library/react";

import StrategyPicksPage, { generateStaticParams } from "./page";
import { STRATEGY_SLUGS, getStrategy } from "~/@/lib/strategies/registry";
import { mapPick, type StrategyPickInput } from "~/@/lib/strategies/map";
import { SHORTLIST_MAX_ROWS } from "~/@/lib/strategies/shortlist";
import { PICKS, UPTREND, pick } from "~/@/components/picks/__tests__/fixtures";

const getStrategyPicks = jest.fn();
const bailOnEmptyRender = jest.fn();
const notFound = jest.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
let searchParams = new URLSearchParams("");

jest.mock("next/navigation", () => ({
  notFound: () => notFound(),
  useSearchParams: () => searchParams,
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
}));
jest.mock("~/@/components/seo/enhanced-structured-data", () => ({
  BreadcrumbListSchema: () => null,
  DatasetStructuredData: () => null,
  ItemListStructuredData: ({ items }: { items: unknown[] }) => (
    <div data-testid="itemlist">{items.length}</div>
  ),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getStrategyPicks", () => ({
  getStrategyPicks: (...args: unknown[]) => getStrategyPicks(...args),
}));

const params = (strategy: string) => Promise.resolve({ strategy });

function rowFor(code: string): HTMLElement {
  const link = screen.getByRole("link", { name: code });
  const row = link.closest("tr");
  if (!row) throw new Error(`no table row for ${code}`);
  return row;
}

describe("StrategyPicksPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchParams = new URLSearchParams("");
    getStrategyPicks.mockResolvedValue(PICKS);
  });

  it("prerenders every registry strategy", () => {
    expect(generateStaticParams()).toEqual(
      STRATEGY_SLUGS.map((strategy) => ({ strategy })),
    );
    expect(STRATEGY_SLUGS).toHaveLength(5);
    expect(generateStaticParams()).toContainEqual({ strategy: "quality-compounders" });
  });

  it("404s an unknown strategy without calling the API", async () => {
    await expect(
      StrategyPicksPage({ params: params("not-a-strategy") }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
    expect(getStrategyPicks).not.toHaveBeenCalled();
  });

  it("renders the header, provenance and regime verdict", async () => {
    const seo = getStrategy("zanger-breakout")!;
    render(await StrategyPicksPage({ params: params("zanger-breakout") }));

    expect(getStrategyPicks).toHaveBeenCalledWith("zanger-breakout");
    expect(
      screen.getByRole("heading", { level: 1, name: seo.h1 }),
    ).toBeInTheDocument();
    expect(screen.getByText(seo.dek)).toBeInTheDocument();
    const kicker = screen.getByRole("link", { name: "Stock picker" }).closest("p");
    expect(kicker).toHaveTextContent("Stock picker · Dan Zanger");

    // Provenance line: price date, fundamentals coverage (stocks with any
    // fundamentals row, growth figures beside it), the ASIC lag, and the
    // disclaimer link.
    const provenance = screen.getByText(/ASIC shorts T\+4/).closest("p")!;
    expect(provenance).toHaveTextContent(
      "Prices to 25 September 2026 · fundamentals for 1,203 of 1,904 stocks (growth figures for 812) · ASIC shorts T+4 · Not financial advice",
    );
    expect(provenance.querySelector("time")).toHaveAttribute("datetime", "2026-09-25");
    expect(
      within(provenance).getByRole("link", { name: "Not financial advice" }),
    ).toHaveAttribute("href", "/disclaimer");

    const regime = screen.getByRole("region", {
      name: "Market regime for Zanger Breakout",
    });
    expect(within(regime).getByText(UPTREND.verdict)).toBeInTheDocument();
    expect(within(regime).getByText("Uptrend")).toBeInTheDocument();
    expect(within(regime).getByText("8,812.3")).toBeInTheDocument();
    expect(within(regime).getByText("+2.5%")).toBeInTheDocument();
  });

  it("marks the current strategy in the switcher and links the others", async () => {
    render(await StrategyPicksPage({ params: params("zanger-breakout") }));
    const nav = screen.getByRole("navigation", { name: "Strategies" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(
      STRATEGY_SLUGS.map((slug) => `/picks/${slug}`),
    );
    expect(within(nav).getByRole("link", { name: "Zanger Breakout" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("renders a triggered row with its status, rule dots and numbers", async () => {
    render(await StrategyPicksPage({ params: params("zanger-breakout") }));

    const row = within(rowFor("BHP"));
    expect(row.getByRole("link", { name: "BHP" })).toHaveAttribute("href", "/shorts/BHP");
    expect(row.getByText("Triggered")).toBeInTheDocument();
    expect(row.getByText("88")).toBeInTheDocument();
    expect(row.getByText("$12.34")).toBeInTheDocument();
    expect(row.getByText("$11.90")).toBeInTheDocument();
    expect(row.getByText("+41.2%")).toBeInTheDocument();
    expect(row.getByText("2.1×")).toBeInTheDocument();

    // One dot per rule, in the strategy's rule order, each explained.
    const dots = row.getByRole("list", { name: "Rule results" });
    const labels = within(dots)
      .getAllByRole("listitem")
      .map((li) => li.querySelector(".sr-only")?.textContent);
    expect(labels).toEqual([
      "1. Explosive growth: pass. Revenue +41.2% YoY",
      "2. A recognisable base: pass. 38-session base, 14.2% deep",
      "3. Breakout on volume: pass. Broke out on 2.1x volume",
      "4. Relative strength: pass. Beat the index by 8.4 points",
    ]);
    expect(dots.querySelector("[title]")).toHaveAttribute(
      "title",
      "1. Explosive growth: pass. Revenue +41.2% YoY",
    );

    expect(screen.getByTestId("itemlist")).toHaveTextContent("3");
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("renders n/a, never 0, for a growth value the data does not have", async () => {
    render(await StrategyPicksPage({ params: params("zanger-breakout") }));

    const row = within(rowFor("PLS"));
    // Revenue YoY, EPS YoY and short % are all missing for PLS. Its
    // fundamentals disclosure says it holds none, in words, not as more n/a.
    expect(row.getAllByText("n/a")).toHaveLength(3);
    expect(row.getByText("No fundamentals held for PLS yet.")).toBeInTheDocument();
    // LTR reports in USD: its P/E reads why it is absent, not a bare n/a.
    expect(within(rowFor("LTR")).queryAllByText("n/a")).toHaveLength(0);
    expect(within(rowFor("LTR")).getByText("n/a (reports in USD)")).toBeInTheDocument();
    expect(row.queryByText("0.0%")).not.toBeInTheDocument();
    expect(row.queryByText("+0.0%")).not.toBeInTheDocument();
    // An unknown rule is drawn and announced as unknown, not as a fail.
    expect(
      row.getByText("4. Relative strength: unknown. Not enough history"),
    ).toBeInTheDocument();
  });

  it("shows each growth figure's basis and filing mark, and a fundamentals disclosure per row", async () => {
    render(await StrategyPicksPage({ params: params("zanger-breakout") }));

    const row = within(rowFor("BHP"));
    expect(row.getByText("FY")).toBeInTheDocument();
    expect(row.getByText("HY")).toBeInTheDocument();
    expect(row.getByText(/\(source: Company filing \(extracted\)\)/)).toBeInTheDocument();
    expect(row.getByRole("link", { name: "Full financials" })).toHaveAttribute(
      "href",
      "/shorts/BHP?tab=financials",
    );
    // A glyph is never shown without its legend.
    expect(screen.getByRole("list", { name: "Source marks" })).toHaveTextContent(
      "Company filing (extracted)",
    );
    // The legend and the footnote say what the tags and the n/m mean.
    expect(
      screen.getByText("Unknown (data missing, or not meaningful for this company)"),
    ).toBeInTheDocument();
    expect(screen.getByText(/TTM is the\s+trailing 12 months, FY a full year, HY a half year/)).toBeInTheDocument();
    expect(screen.getByText(/means it is not meaningful/)).toBeInTheDocument();
  });

  // Absent is not a status: an API that predates fundamentals_rows_count
  // (it reads 0) gets the page it always had, and the coverage line says
  // what its one count counts.
  it("renders an older API's picks as before: growth-figure coverage, no disclosure", async () => {
    getStrategyPicks.mockResolvedValue({
      ...PICKS,
      fundamentalsRowsCount: 0,
      picks: PICKS.picks.map(({ fundamentals: _omit, ...row }) => row),
    });
    render(await StrategyPicksPage({ params: params("zanger-breakout") }));

    expect(screen.getByText(/ASIC shorts T\+4/).closest("p")).toHaveTextContent(
      "Prices to 25 September 2026 · growth figures for 812 of 1,904 stocks · ASIC shorts T+4",
    );
    expect(document.querySelector("details")).toBeNull();
    expect(screen.queryByText(/No fundamentals held/)).not.toBeInTheDocument();
    expect(within(rowFor("BHP")).queryByText("FY")).not.toBeInTheDocument();
  });

  it("renders the strategy panel sections from the API prose", async () => {
    render(await StrategyPicksPage({ params: params("zanger-breakout") }));

    for (const heading of [
      "Ranked picks",
      "The method",
      "The rules",
      "What this cannot see",
      "Sources",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
    }
    expect(
      screen.getByText("Dan Zanger turned a small account into millions by buying breakouts."),
    ).toBeInTheDocument();
    expect(screen.getByText("Buy the breakout on heavy volume.")).toBeInTheDocument();
    expect(
      screen.getByText("Close above the prior 40-session high on 1.5x average volume."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("How we test it")).toHaveLength(4);
    expect(screen.getAllByText("Company fundamentals").length).toBeGreaterThan(0);
    expect(screen.getByText("weeks to months")).toBeInTheDocument();
    expect(
      screen.getByText("We do not classify the base shape; we only detect that one exists."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Fortune, 2000: profile of Dan Zanger's 29,233% year."),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/Not financial advice/).length).toBeGreaterThan(1);

    const links = screen.getAllByRole("link").map((a) => a.getAttribute("href"));
    for (const related of getStrategy("zanger-breakout")!.related) {
      expect(links).toContain(`/picks/${related}`);
    }
    expect(links).toEqual(expect.arrayContaining(["/scans", "/screener", "/battlegrounds"]));
  });

  // Measured 2026-10-07: 100 rows, each with a fundamentals disclosure, in
  // the HTML, the fallback's RSC tree and the island's props made
  // /picks/minervini-trend-template 1.85 MB. The page renders the shortlist
  // (SHORTLIST_MAX_ROWS at most) and the chips still count every row.
  it("renders at most 40 rows of a long list, with chips that count every ranked row", async () => {
    const triggered = Array.from({ length: 60 }, (_, i) =>
      pick({ code: `T${String(i).padStart(2, "0")}`, rank: i + 1, status: "triggered" }),
    );
    const watch = Array.from({ length: 40 }, (_, i) =>
      pick({ code: `W${String(i).padStart(2, "0")}`, rank: 61 + i, status: "watch" }),
    );
    getStrategyPicks.mockResolvedValue({
      ...PICKS,
      picks: [...triggered, ...watch],
      totalCount: 212,
    });
    render(await StrategyPicksPage({ params: params("zanger-breakout") }));

    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(1 + SHORTLIST_MAX_ROWS);
    expect(within(table).getByRole("link", { name: "T39" })).toBeInTheDocument();
    expect(within(table).queryByRole("link", { name: "T40" })).not.toBeInTheDocument();
    expect(screen.getByText(/Showing 40 of 212 ranked stocks/)).toBeInTheDocument();

    const nav = screen.getByRole("navigation", { name: "Filter picks by status" });
    expect(within(nav).getByRole("link", { name: /^Triggered/ })).toHaveTextContent("Triggered60");
    expect(within(nav).getByRole("link", { name: /^Watch/ })).toHaveTextContent("Watch40+");
    expect(screen.getByTestId("itemlist")).toHaveTextContent("15");
  });

  it("renders the copy-only shell and bails the render when the read fails", async () => {
    getStrategyPicks.mockResolvedValue(null);
    const seo = getStrategy("canslim")!;

    render(await StrategyPicksPage({ params: params("canslim") }));

    expect(screen.getByRole("heading", { level: 1, name: seo.h1 })).toBeInTheDocument();
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByTestId("itemlist")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Not financial advice" })).toBeInTheDocument();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });

  it("renders a downtrend verdict in the warm alert register, never red", async () => {
    getStrategyPicks.mockResolvedValue({
      ...PICKS,
      regime: {
        ...UPTREND,
        regime: "downtrend",
        close: 7900,
        verdict: "Stand aside: XJO is below its 200-day average.",
      },
    });

    render(await StrategyPicksPage({ params: params("zanger-breakout") }));

    const regime = screen.getByRole("region", {
      name: "Market regime for Zanger Breakout",
    });
    expect(within(regime).getByText("Downtrend")).toBeInTheDocument();
    expect(
      within(regime).getByText("Stand aside: XJO is below its 200-day average."),
    ).toBeInTheDocument();
    expect(regime.className).toContain("border-accent");
    expect(regime.outerHTML).not.toMatch(/(?:bg|text|border)-(?:red|destructive)/);
  });
});

// PickRow.fundamentals carries only what the row renders (plan §7.2): the
// rows the page hands its client island may grow by at most 25 KB for a
// 100-row table. The fixture is the WORST case: every row carries every
// rendered fundamentals field, with raw API precision, some filing marks,
// some USD reporters and some financials.
describe("picks payload budget", () => {
  const BUDGET_BYTES = 25 * 1024;
  const NOT_MEANINGFUL = [
    "gross_margin_pct",
    "operating_margin_pct",
    "fcf_margin_pct",
    "fcf_conversion",
    "net_debt",
    "net_debt_to_ebitda",
    "net_debt_to_equity",
    "current_ratio",
    "interest_cover",
  ];

  function wirePick(i: number, withFundamentals: boolean): StrategyPickInput {
    const financial = i % 10 === 5;
    return {
      rank: i + 1,
      stockCode: `C${String(i).padStart(3, "0")}`,
      companyName: `Company Number ${i} Limited`,
      industry: "Metals & Mining",
      status: i < 10 ? "triggered" : i < 30 ? "setup" : "watch",
      score: 88.123456789 - i * 0.37,
      rules: ["growth", "base", "breakout", "rs"].map((ruleId, k) => ({
        ruleId,
        status: k % 2 ? "pass" : "fail",
        detail: `Evidence for ${ruleId}: 12.3% over 38 sessions`,
      })),
      close: 12.3456,
      asOf: "2026-09-25",
      volumeRatio50d: 2.123456,
      baseDepthPct: 14.23456,
      baseLengthDays: 38,
      pivot: 11.9876,
      revenueYoyPct: 41.23456789,
      hasRevenueYoy: true,
      epsYoyPct: 22.5123456,
      hasEpsYoy: true,
      rs3mPct: 8.4123456,
      hasRs3mPct: true,
      shortPct: 3.2123,
      hasShortPct: true,
      marketCap: 1234567890.123,
      hasMarketCap: true,
      hasClose: true,
      logoUrl: `https://storage.googleapis.com/shorted-company-logos/logos/C${i}.png`,
      fundamentals: withFundamentals
        ? {
            revenueBasisPeriodType: ["annual", "half", "ttm"][i % 3],
            revenuePeriodEnd: "2026-06-30",
            epsBasisPeriodType: "annual",
            epsPeriodEnd: "2025-12-31",
            currency: i % 10 === 0 ? "USD" : "AUD",
            fetchedAt: "2026-09-27T20:00:00Z",
            revenueBasisSource: i % 4 === 0 ? "filing" : "vendor",
            epsBasisSource: i % 5 === 0 ? "filing" : "vendor",
            netMarginPct: 12.3456789,
            hasNetMarginPct: true,
            roePct: -18.23456,
            hasRoePct: true,
            fcfMarginPct: 9.1234,
            hasFcfMarginPct: !financial,
            netDebtToEbitda: -1.23456,
            hasNetDebtToEbitda: !financial,
            peRatio: 145.678,
            hasPeRatio: i % 10 !== 0,
            isFinancial: financial,
            netIncomePositive: true,
            notMeaningful: financial ? NOT_MEANINGFUL : [],
          }
        : undefined,
    };
  }

  const bytes = (withFundamentals: boolean) =>
    JSON.stringify(
      Array.from({ length: 100 }, (_, i) => mapPick(wirePick(i, withFundamentals))),
    ).length;

  it("keeps a 100-row table within +25 KB of the rows without fundamentals", () => {
    const today = bytes(false);
    const withFundamentals = bytes(true);
    expect(withFundamentals).toBeGreaterThan(today);
    expect(withFundamentals - today).toBeLessThanOrEqual(BUDGET_BYTES);
  });
});
