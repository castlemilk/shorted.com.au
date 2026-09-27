import { render, screen, within } from "@testing-library/react";

import StrategyPicksPage, { generateStaticParams } from "./page";
import { STRATEGY_SLUGS, getStrategy } from "~/@/lib/strategies/registry";
import { PICKS, UPTREND } from "~/@/components/picks/__tests__/fixtures";

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
    expect(STRATEGY_SLUGS).toHaveLength(4);
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

    // Provenance line: price date, fundamentals coverage, the ASIC lag, and
    // the disclaimer link.
    const provenance = screen.getByText(/ASIC shorts T\+4/).closest("p")!;
    expect(provenance).toHaveTextContent(
      "Prices to 25 September 2026 · fundamentals for 812 of 1,904 stocks · ASIC shorts T+4 · Not financial advice",
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
    // Revenue YoY, EPS YoY and short % are all missing for PLS.
    expect(row.getAllByText("n/a")).toHaveLength(3);
    expect(row.queryByText("0.0%")).not.toBeInTheDocument();
    expect(row.queryByText("+0.0%")).not.toBeInTheDocument();
    // An unknown rule is drawn and announced as unknown, not as a fail.
    expect(
      row.getByText("4. Relative strength: unknown. Not enough history"),
    ).toBeInTheDocument();
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
