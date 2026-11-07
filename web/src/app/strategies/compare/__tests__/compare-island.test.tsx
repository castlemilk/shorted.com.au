import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import { CompareIsland, parseCompareIds } from "../compare-island";
import { mapCompareStrategies } from "~/@/lib/strategies/map-backtest";
import { EXPLORER_COPY } from "~/@/lib/strategies/explorer";

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
        note: "in-sample to 2026-11-23, recorded after",
        totalReturnPct: 61.2,
        cagrPct: 16.9,
        hasCagr: true,
        maxDrawdownPct: -11.4,
        closedTrades: 180,
        sharpe: 0.9,
        sharpeSe: 0.4,
        hasSharpe: true,
      },
      series: [
        { date: "2023-01-31", equity: 100000, benchmark: 2000 },
        { date: "2026-10-31", equity: 161200, benchmark: 2600 },
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
        note: "in-sample to 2026-11-23, recorded after",
        totalReturnPct: 12,
        // The API sets the flag when it states the total return; the shared mapper reads
        // an unflagged total as absent (n/a), never as zero.
        hasTotalReturn: true,
        maxDrawdownPct: -8,
        closedTrades: 90,
      },
      series: [
        { date: "2023-01-31", equity: 100000, benchmark: 2000 },
        { date: "2026-10-31", equity: 112000, benchmark: 2600 },
      ],
    },
  ],
  correlations: [{ a: "crowded-short-breakout", b: "minervini-trend-template", correlation: 0.31, hasCorrelation: true, days: 700 }],
  ruleDiffs: [{ a: "crowded-short-breakout", b: "minervini-trend-template", field: "Universe", aValue: "reported short", bValue: "all ASX" }],
});

const SURVIVORSHIP = { "crowded-short-breakout": "Flatters results.", "minervini-trend-template": "" };

function ok() {
  return { ok: true, comparison: COMPARISON, survivorship: SURVIVORSHIP };
}

describe("parseCompareIds", () => {
  it("keeps valid unique ids, at most three", () => {
    expect(parseCompareIds("a-b,a-b, c ,bad id,d,e")).toEqual(["a-b", "c", "d"]);
    expect(parseCompareIds(null)).toEqual([]);
  });
});

describe("CompareIsland: the picker", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = new URLSearchParams("ids=crowded-short-breakout,minervini-trend-template");
    mockSession = { data: null, status: "unauthenticated" };
  });

  it("offers the registry's strategies with the URL's ids ticked", () => {
    render(<CompareIsland />);
    expect(screen.getByRole("group", { name: "Add a strategy" })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Crowded-Short Breakout" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Minervini Trend Template" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "CAN SLIM" })).not.toBeChecked();
  });

  it("holds at most three: a fourth is disabled, and a removal frees it", () => {
    render(<CompareIsland />);
    fireEvent.click(screen.getByRole("checkbox", { name: "CAN SLIM" }));
    expect(screen.getByRole("checkbox", { name: "Zanger Breakout" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "Minervini Trend Template" }));
    expect(screen.getByRole("checkbox", { name: "Zanger Breakout" })).toBeEnabled();
  });

  it("writes ?ids= with history.replaceState(null, ...) as the picks change", () => {
    const replaceState = jest.spyOn(window.history, "replaceState");
    render(<CompareIsland />);
    fireEvent.click(screen.getByRole("checkbox", { name: "CAN SLIM" }));
    expect(replaceState).toHaveBeenLastCalledWith(
      null,
      "",
      expect.stringContaining("?ids=crowded-short-breakout,minervini-trend-template,canslim"),
    );
    replaceState.mockRestore();
  });

  it("names an id the registry does not hold, and reads no comparison for it", () => {
    mockSession = SIGNED_IN;
    mockParams = new URLSearchParams("ids=crowded-short-breakout,nope");
    render(<CompareIsland />);
    expect(screen.getByText(/Not a strategy we publish: nope/)).toBeInTheDocument();
    expect(compareStrategiesForViewer).not.toHaveBeenCalled();
  });
});

describe("CompareIsland: the signed-out visitor", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = new URLSearchParams("ids=crowded-short-breakout,minervini-trend-template");
    mockSession = { data: null, status: "unauthenticated" };
  });

  it("gives the sign-in prompt, carrying the chosen ids in callbackUrl, and makes no request", () => {
    render(<CompareIsland />);
    expect(screen.getByRole("heading", { name: "Sign in to compare" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in to compare" })).toHaveAttribute(
      "href",
      `/signin?callbackUrl=${encodeURIComponent("/strategies/compare?ids=crowded-short-breakout,minervini-trend-template")}`,
    );
    expect(compareStrategiesForViewer).not.toHaveBeenCalled();
  });
});

describe("CompareIsland: the comparison", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = new URLSearchParams("ids=crowded-short-breakout,minervini-trend-template");
    mockSession = SIGNED_IN;
  });

  it("loads at two picks and draws the window figures with their labels", async () => {
    compareStrategiesForViewer.mockResolvedValue(ok());
    render(<CompareIsland />);
    expect(compareStrategiesForViewer).toHaveBeenCalledWith(["crowded-short-breakout", "minervini-trend-template"]);
    await waitFor(() => expect(screen.getByRole("table")).toBeInTheDocument());
    expect(screen.getByText("Common window: 3 January 2023 to 6 November 2026")).toBeInTheDocument();
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("+16.9% a year");
    expect(rows[0]).toHaveTextContent("in-sample to 2026-11-23, recorded after");
    expect(rows[0]).toHaveTextContent("Flatters results.");
    expect(rows[0]).toHaveTextContent("0.90 (± 0.40)");
    expect(rows[1]).toHaveTextContent("+12.0% total");
    expect(rows[1]).toHaveTextContent("not annualised");
    expect(rows[1]).toHaveTextContent("−8.0%");
    // Minervini carries no Sharpe (fewer than 126 daily returns in this fixture): n/a, not 0.
    expect(rows[1]).toHaveTextContent("n/a");
    expect(screen.getByText(EXPLORER_COPY.costs)).toBeInTheDocument();
    expect(screen.getByText("Crowded-Short Breakout with Minervini Trend Template: 0.31 over 700 days")).toBeInTheDocument();
    expect(screen.getByText(/Where the rules differ/)).toBeInTheDocument();
    expect(screen.getByText(/Universe: Crowded-Short Breakout reported short, Minervini Trend Template all ASX/)).toBeInTheDocument();
    expect(screen.getByText(EXPLORER_COPY.hypothetical)).toBeInTheDocument();
  });

  it("draws the curves on one scale with the XJT line, axis labels and end values", async () => {
    compareStrategiesForViewer.mockResolvedValue(ok());
    render(<CompareIsland />);
    await waitFor(() => expect(screen.getByRole("img", { name: /one line per strategy and XJT/ })).toBeInTheDocument());
    expect(document.querySelectorAll("[data-curve]")).toHaveLength(3);
    expect(document.querySelector('[data-curve="xjt"]')).not.toBeNull();
    expect(screen.getByText("A$161,200 at the end", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("S&P/ASX 200 Gross TR (XJT): A$130,000 at the end", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("A$161,200")).toBeInTheDocument();
  });

  it("names a permanent failure in its own words, with no retry", async () => {
    compareStrategiesForViewer.mockResolvedValue({ ok: false, reason: "not-found" });
    render(<CompareIsland />);
    expect(await screen.findByText(/has no published record/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("names a refused session as permanent, not as a failure to retry", async () => {
    compareStrategiesForViewer.mockResolvedValue({ ok: false, reason: "signed-out" });
    render(<CompareIsland />);
    expect(await screen.findByText(/Sign in again to compare/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("offers a retry on a transient failure, and reads again when pressed", async () => {
    compareStrategiesForViewer.mockResolvedValueOnce({ ok: false, reason: "unavailable" });
    render(<CompareIsland />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(compareStrategiesForViewer).toHaveBeenCalledTimes(2));
  });

  it("stops waiting when the action rejects, and offers a retry", async () => {
    compareStrategiesForViewer.mockRejectedValueOnce(new Error("network"));
    render(<CompareIsland />);
    expect(await screen.findByText("The comparison is unavailable right now.")).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Loading the comparison" })).toBeNull();
  });

  it("asks for a second strategy with one pick, and reads nothing", () => {
    mockParams = new URLSearchParams("ids=canslim");
    render(<CompareIsland />);
    expect(screen.getByText("Pick one more strategy to see the comparison.")).toBeInTheDocument();
    expect(compareStrategiesForViewer).not.toHaveBeenCalled();
  });

  it("opens the comparison when a second strategy is picked", async () => {
    mockParams = new URLSearchParams("ids=canslim");
    compareStrategiesForViewer.mockResolvedValue(ok());
    render(<CompareIsland />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Crowded-Short Breakout" }));
    await waitFor(() => expect(compareStrategiesForViewer).toHaveBeenCalledWith(["canslim", "crowded-short-breakout"]));
    expect(screen.getByRole("table")).toBeInTheDocument();
  });
});
