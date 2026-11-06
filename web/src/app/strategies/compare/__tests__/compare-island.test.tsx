import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { CompareIsland, parseCompareIds } from "../compare-island";
import { mapCompareStrategies } from "~/@/lib/strategies/map-backtest";

let mockParams = new URLSearchParams();
let mockSession: { data: unknown; status: string } = { data: null, status: "unauthenticated" };
const compareStrategiesForViewer = jest.fn();

jest.mock("next/navigation", () => ({
  useSearchParams: () => mockParams,
}));
jest.mock("next-auth/react", () => ({
  useSession: () => mockSession,
}));
jest.mock("~/app/actions/strategies/compare", () => ({
  compareStrategiesForViewer: (...args: unknown[]) => compareStrategiesForViewer(...args),
}));

const SIGNED_IN = { data: { user: { id: "u1" } }, status: "authenticated" };

const COMPARISON = mapCompareStrategies({
  windowId: "common",
  windowFrom: "2023-01-03",
  windowTo: "2026-11-06",
  entries: [
    {
      strategyRef: "crowded-short-breakout",
      strategyId: "crowded-short-breakout",
      name: "Crowded-Short Breakout",
      state: "published",
      window: {
        window: "since_2023",
        from: "2023-01-03",
        to: "2026-11-06",
        totalReturnPct: 61.2,
        cagrPct: 16.9,
        hasCagr: true,
        maxDrawdownPct: -11.4,
        closedTrades: 180,
        sharpe: 0.9,
        hasSharpe: true,
      },
      series: [
        { date: "2023-01-31", equity: 100000 },
        { date: "2026-10-31", equity: 161200 },
      ],
    },
    {
      strategyRef: "minervini-trend-template",
      strategyId: "minervini-trend-template",
      name: "Minervini Trend Template",
      state: "published",
      window: {
        window: "since_2023",
        from: "2023-01-03",
        to: "2026-11-06",
        totalReturnPct: 12,
        maxDrawdownPct: -8,
        closedTrades: 90,
        hasCagr: false,
      },
      series: [
        { date: "2023-01-31", equity: 100000 },
        { date: "2026-10-31", equity: 112000 },
      ],
    },
  ],
  correlations: [{ a: "crowded-short-breakout", b: "minervini-trend-template", correlation: 0.31, hasCorrelation: true, days: 700 }],
});

describe("parseCompareIds", () => {
  it("keeps valid unique ids, at most three", () => {
    expect(parseCompareIds("a-b,a-b, c ,bad id,d,e")).toEqual(["a-b", "c", "d"]);
    expect(parseCompareIds(null)).toEqual([]);
  });
});

describe("CompareIsland", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = new URLSearchParams("ids=crowded-short-breakout,minervini-trend-template");
    mockSession = { data: null, status: "unauthenticated" };
  });

  it("gives an anonymous visitor the sign-in prompt and makes no request", () => {
    render(<CompareIsland />);
    expect(screen.getByRole("heading", { name: "Sign in to compare" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      `/signin?callbackUrl=${encodeURIComponent("/strategies/compare?ids=crowded-short-breakout,minervini-trend-template")}`,
    );
    expect(compareStrategiesForViewer).not.toHaveBeenCalled();
  });

  it("asks a signed-in visitor with fewer than two ids to choose strategies", () => {
    mockSession = SIGNED_IN;
    mockParams = new URLSearchParams("ids=canslim");
    render(<CompareIsland />);
    expect(screen.getByRole("heading", { name: "Choose two or three strategies" })).toBeInTheDocument();
    expect(compareStrategiesForViewer).not.toHaveBeenCalled();
  });

  it("reads the comparison for a signed-in visitor and draws its window figures", async () => {
    mockSession = SIGNED_IN;
    compareStrategiesForViewer.mockResolvedValue({ ok: true, comparison: COMPARISON });
    render(<CompareIsland />);
    expect(compareStrategiesForViewer).toHaveBeenCalledWith(["crowded-short-breakout", "minervini-trend-template"]);
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    expect(screen.getByText("Common window: 3 January 2023 to 6 November 2026")).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("+16.9% a year");
    // Under a year is not annualised: the total return is marked so.
    expect(rows[1]).toHaveTextContent("+12.0% total");
    expect(rows[1]).toHaveTextContent("not annualised");
    expect(rows[1]).toHaveTextContent("−8.0%");
    expect(screen.getByText("Crowded-Short Breakout with Minervini Trend Template: 0.31 over 700 days")).toBeInTheDocument();
    expect(screen.getByText(/Not financial advice/)).toBeInTheDocument();
    expect(document.querySelectorAll("[data-curve]")).toHaveLength(2);
  });

  it("says the comparison is unavailable when the read fails, without a page error", async () => {
    mockSession = SIGNED_IN;
    compareStrategiesForViewer.mockResolvedValue({ ok: false, reason: "unavailable" });
    render(<CompareIsland />);
    expect(await screen.findByText(/The comparison is unavailable right now/)).toBeInTheDocument();
  });
});
