/// <reference types="jest" />

/**
 * The index fund window's island (spec 13.5): a stock's code opens its fund
 * panel through the series loader, a slider move asks the positions loader for
 * the new pair and writes it into the link, and a failed read leaves the rows it
 * had with the outage beside them. Both loaders are props, so the island is
 * drawn with plain fakes.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { FundPositionChangesPage, StockFundSeriesPage } from "~/app/actions/ownershipDesk";
import type { FundChangeRow } from "../fund-changes";
import { FundPositions, type FundPositionsProps } from "../fund-positions";

let mockSearchParams = new URLSearchParams("");
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

const DATES = ["2026-08-31", "2026-09-30", "2026-10-31"];

function row(over: Partial<FundChangeRow> & { code: string }): FundChangeRow {
  return {
    name: `${over.code} Ltd`,
    weightFrom: 5,
    weightTo: 5,
    delta: 0,
    valueFrom: 1_000_000_000,
    valueTo: 1_000_000_000,
    funds: 2,
    state: "current",
    ...over,
  };
}

const ROWS: FundChangeRow[] = [
  row({ code: "BHP", name: "BHP Group", weightFrom: 5, weightTo: 6.5, delta: 1.5 }),
  row({ code: "CBA", name: "Commonwealth Bank", weightFrom: 4, weightTo: 3, delta: -1 }),
];

function page(over: Partial<FundPositionChangesPage> = {}): FundPositionChangesPage {
  return { ok: true, error: "", snapshotDates: DATES, from: "2026-09-30", to: "2026-10-31", rows: ROWS, ...over };
}

const SERIES: StockFundSeriesPage = {
  ok: true,
  error: "",
  stockCode: "BHP",
  funds: [
    {
      institutionSlug: "vanguard",
      institutionName: "Vanguard",
      fundName: "Australian Shares Index",
      sourceKind: "etf",
      points: [
        { asAt: "2026-09-30", weightPct: 5, valueAud: 500 },
        { asAt: "2026-10-31", weightPct: 6.5, valueAud: 650 },
      ],
    },
  ],
};

function setup(over: Partial<FundPositionsProps> = {}) {
  const loadPositions = jest.fn<Promise<FundPositionChangesPage>, [{ from: string; to: string }]>(() =>
    Promise.resolve(page({ from: "2026-08-31", to: "2026-09-30" })),
  );
  const loadSeries = jest.fn<Promise<StockFundSeriesPage>, [{ stockCode: string }]>(() => Promise.resolve(SERIES));
  const props: FundPositionsProps = { initial: page(), loadPositions, loadSeries, ...over };
  const utils = render(<FundPositions {...props} />);
  return { ...utils, loadPositions, loadSeries };
}

beforeEach(() => {
  mockSearchParams = new URLSearchParams("");
  window.history.replaceState(null, "", "/ownership");
});

describe("FundPositions", () => {
  it("opens a stock's panel through the series loader and names each fund with its file dates", async () => {
    const { loadSeries } = setup();
    fireEvent.click(screen.getByRole("button", { name: /BHP/ }));
    expect(loadSeries).toHaveBeenCalledWith({ stockCode: "BHP" });
    expect(await screen.findByText("Australian Shares Index")).toBeInTheDocument();
    expect(screen.getByText("as at 2026-09-30 to 2026-10-31")).toBeInTheDocument();
  });

  it("asks the positions loader for the pair a slider move names, and writes it into the link", async () => {
    const { loadPositions } = setup();
    fireEvent.keyDown(screen.getByRole("slider", { name: "Earlier snapshot" }), { key: "ArrowLeft" });
    await waitFor(() => expect(loadPositions).toHaveBeenCalledWith({ from: "2026-08-31", to: "2026-10-31" }));
    await waitFor(() => expect(window.location.search).toBe("?from=2026-08-31&to=2026-09-30"));
  });

  it("asks once on mount for a pair the link names that is not the default", async () => {
    mockSearchParams = new URLSearchParams("from=2026-08-31&to=2026-09-30");
    const { loadPositions } = setup();
    await waitFor(() => expect(loadPositions).toHaveBeenCalledTimes(1));
    expect(loadPositions).toHaveBeenCalledWith({ from: "2026-08-31", to: "2026-09-30" });
  });

  it("keeps the rows it had, with the outage beside them, when a move fails", async () => {
    const loadPositions = jest.fn(() =>
      Promise.resolve(page({ ok: false, error: "", rows: [], snapshotDates: [], from: "", to: "" })),
    );
    setup({ loadPositions });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Earlier snapshot" }), { key: "ArrowLeft" });
    expect(
      await screen.findByText(
        "The index fund files could not be read just now. Nothing here is missing from the register: this is our end.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /BHP/ })).toBeInTheDocument();
  });

  it("shows the refusal's own reason when the loader refuses the query", async () => {
    const loadPositions = jest.fn(() =>
      Promise.resolve(page({ ok: false, error: "until is before since", rows: [], snapshotDates: [], from: "", to: "" })),
    );
    setup({ loadPositions });
    fireEvent.keyDown(screen.getByRole("slider", { name: "Earlier snapshot" }), { key: "ArrowLeft" });
    expect(await screen.findByText("until is before since")).toBeInTheDocument();
  });

  it("reads a stock's panel as loading, then draws it", async () => {
    let resolve: (value: StockFundSeriesPage) => void = () => undefined;
    const loadSeries = jest.fn(() => new Promise<StockFundSeriesPage>((r) => (resolve = r)));
    setup({ loadSeries });
    fireEvent.click(screen.getByRole("button", { name: /CBA/ }));
    // The loading line is the shared status row, and the panel's column is reserved while it loads.
    expect(screen.getByText("Loading…")).toBeInTheDocument();
    expect(screen.getByRole("complementary")).toBeInTheDocument();
    await act(async () => resolve({ ...SERIES, stockCode: "CBA" }));
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(await screen.findByText("Australian Shares Index")).toBeInTheDocument();
  });
});

describe("FundPositions moves", () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it("sends one request for a burst of moves, the pair the handles came to rest on", async () => {
    jest.useFakeTimers();
    const { loadPositions } = setup();
    const earlier = screen.getByRole("slider", { name: "Earlier snapshot" });
    fireEvent.keyDown(earlier, { key: "ArrowLeft" });
    fireEvent.keyDown(earlier, { key: "ArrowRight" });
    expect(screen.getByRole("slider", { name: "Earlier snapshot" })).toHaveAttribute("aria-valuetext", "2026-09-30");
    expect(loadPositions).not.toHaveBeenCalled();
    await act(async () => {
      jest.advanceTimersByTime(300);
    });
    expect(loadPositions).toHaveBeenCalledTimes(1);
    expect(loadPositions).toHaveBeenCalledWith({ from: "2026-09-30", to: "2026-10-31" });
  });

  it("drops a bad pair from the link when the read that asked for it fails", async () => {
    window.history.replaceState(null, "", "/ownership?from=2026-08-31&to=2026-09-30");
    mockSearchParams = new URLSearchParams("from=2026-08-31&to=2026-09-30");
    const loadPositions = jest.fn(() =>
      Promise.resolve(page({ ok: false, error: "", rows: [], snapshotDates: [], from: "", to: "" })),
    );
    setup({ loadPositions });
    expect(
      await screen.findByText(
        "The index fund files could not be read just now. Nothing here is missing from the register: this is our end.",
      ),
    ).toBeInTheDocument();
    await waitFor(() => expect(window.location.search).toBe(""));
  });
});
