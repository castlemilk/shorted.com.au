/// <reference types="jest" />

import { render, screen, waitFor, within } from "@testing-library/react";
import { FundPortfolioMapView, TREEMAP_WIDTH, logoFits } from "../fund-portfolio-map";

// SearchCombobox positions its panel with :popover-open, which jsdom does not parse. The
// combobox is the gamma library's own and is tested there; this file tests the map.
jest.mock("~/@/components/gamma/SearchCombobox", () => ({
  SearchCombobox: ({ label }: { label: string }) => <div data-testid="find-holding">{label}</div>,
}));
import type { FundPortfolio, LoadFundPortfolio, PortfolioHolding } from "../fund-model";

function holding(code: string, weightPct: number | null, industry: string): PortfolioHolding {
  return {
    code,
    name: `${code} Holdings Ltd`,
    industry,
    weightPct,
    units: 25_400_000,
    valueAud: 1_000_000,
    sharesOnIssue: 5_000_000_000,
    estCompanyPct: 0.5,
    sharesOnIssueAsAt: "2026-10-31",
  };
}

const PORTFOLIO: FundPortfolio = {
  key: "asx:A200",
  ticker: "A200",
  name: "BetaShares Australia 200 ETF",
  institutionSlug: "betashares",
  institutionName: "Betashares",
  sourceKind: "etf",
  pooled: false,
  asAt: "2026-10-31",
  sourceUrl: "",
  snapshotDates: ["2026-09-30", "2026-10-31"],
  holdings: [holding("BHP", 8.4, "Materials"), holding("CBA", 9.1, "Banks"), holding("NOHOLD", null, "Banks")],
  holdingsTotal: 3,
  top10Pct: 44.2,
  sectorWeights: [],
};

const loadPortfolio: LoadFundPortfolio = jest.fn(async ({ asAt }) => ({
  ok: true,
  fund: { ...PORTFOLIO, asAt: asAt ?? PORTFOLIO.asAt },
}));

function renderMap(search: string, navigate = jest.fn()) {
  render(
    <FundPortfolioMapView
      portfolio={PORTFOLIO}
      loadPortfolio={loadPortfolio}
      params={new URLSearchParams(search)}
      pathname="/ownership/funds/asx%3AA200"
      navigate={navigate}
    />,
  );
  return navigate;
}

describe("the fund portfolio map (spec 14.3, Fund page)", () => {
  it("draws every holding with a stated weight as a cell linked to its selection", () => {
    renderMap("");
    const group = screen.getByRole("group", { name: /Holdings by sector/ });
    // A cell selects in place (spec 14.9): a button with its code, not a link.
    const cell = within(group).getByRole("button", { name: /BHP/ });
    expect(cell).toHaveAttribute("data-code", "BHP");
    expect(within(group).getByRole("button", { name: /CBA/ })).toBeInTheDocument();
    expect(within(group).queryByRole("button", { name: /NOHOLD/ })).not.toBeInTheDocument();
  });

  it("names each sector with its weight in its header", () => {
    renderMap("");
    expect(screen.getByText("Materials (8%)")).toBeInTheDocument();
    expect(screen.getByText("Banks (9%)")).toBeInTheDocument();
  });

  it("lists the holdings in the holdings view, with n/a for a figure not stated", () => {
    renderMap("view=holdings");
    const table = screen.getByRole("table");
    expect(within(table).getByText("NOHOLD")).toBeInTheDocument();
    expect(within(table).getAllByText("n/a").length).toBeGreaterThan(0);
  });

  it("chips the selected holding and clears it through the URL, without a series of its own", () => {
    renderMap("sel=holding%3Aasx%3AA200%2FBHP");
    expect(screen.getByRole("link", { name: "BHP selected, clear" })).toHaveAttribute("href", "/ownership/funds/asx%3AA200");
    expect(screen.queryByText(/Weight across snapshots/)).not.toBeInTheDocument();
  });

  it("reads a zoomed sector and offers to clear it", () => {
    renderMap("focus=Materials");
    expect(screen.getByRole("link", { name: "Focus Materials, clear" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /BHP/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /CBA/ })).not.toBeInTheDocument();
  });

  it("reads another file date on demand, and says so while it loads", async () => {
    renderMap("as=2026-09-30");
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    await waitFor(() => expect(loadPortfolio).toHaveBeenCalledWith({ fundKey: "asx:A200", asAt: "2026-09-30" }));
    expect(await screen.findByRole("group", { name: /Holdings by sector/ })).toBeInTheDocument();
  });

  it("names the area and the colour, and never a market direction", () => {
    renderMap("");
    expect(screen.getByText("Area: weight in the fund · Colour: sector")).toBeInTheDocument();
  });
});

describe("the sector headers of the portfolio map (spec 14.3, Fund page)", () => {
  it("focuses the treemap on a sector from its header, through the URL", () => {
    renderMap("");
    expect(screen.getByRole("link", { name: "Focus Materials" })).toHaveAttribute(
      "href",
      "/ownership/funds/asx%3AA200?focus=Materials",
    );
  });

  it("clears the focus from the header of the sector it zooms to", () => {
    renderMap("focus=Materials");
    expect(screen.getByRole("link", { name: "Clear focus on Materials" })).toHaveAttribute(
      "href",
      "/ownership/funds/asx%3AA200",
    );
  });
});

describe("the cell logo threshold (spec 14.2)", () => {
  it("judges a cell in rendered pixels: 72 x 48 on screen, not in canvas units", () => {
    const cell = { x0: 0, x1: 72, y0: 0, y1: 48 };
    expect(logoFits(cell, TREEMAP_WIDTH)).toBe(true);
    expect(logoFits(cell, 480)).toBe(false);
  });
});
