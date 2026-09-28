import { act, render, screen, waitFor, within } from "@testing-library/react";

import { PicksSortedView, SORT_TIMEOUT_MS } from "./picks-sorted-view";
import { GET_STRATEGY_PICKS_PATH, fetchSortedPicks } from "./picks-sort-fetch";
import {
  PICKS,
  PROTOJSON_PICKS,
  SETUP,
  TRIGGERED,
  WATCH,
  ZANGER,
  pick,
} from "~/@/components/picks/__tests__/fixtures";
import type { PickRow } from "~/@/lib/strategies/types";
import { getStrategyPicks } from "~/app/actions/getStrategyPicks";

// The server action's collaborators, so the parity test can drive it with the
// same protojson fixture the island's fetch receives.
const mockGetStrategyPicks = jest.fn();
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: jest.fn(() => ({
    getStrategyPicks: (...args: unknown[]) => mockGetStrategyPicks(...args),
  })),
}));
jest.mock("~/gen/shorts/v1alpha1/strategies_pb", () => ({
  StrategyService: {},
}));
jest.mock("next/cache", () => ({
  unstable_cache: (loader: () => Promise<unknown>) => loader,
}));
jest.mock("~/app/actions/config", () => ({
  SHORTS_API_URL: "http://api.test",
  serverFetchOutsideNextCache: jest.fn(),
  skipForBuild: () => false,
}));

let searchParams = new URLSearchParams("");
jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

const RULES = ZANGER.rules.map((rule) => ({ id: rule.id, title: rule.title }));
const fetchMock = jest.fn();

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function renderView(rows: PickRow[] = PICKS.picks, totalCount = rows.length) {
  return render(
    <PicksSortedView
      strategyId="zanger-breakout"
      rows={rows}
      totalCount={totalCount}
      rules={RULES}
      basePath="/picks/zanger-breakout"
      caption="Zanger Breakout Strategy: ranked ASX picks"
      showFundamentals
    />,
  );
}

function tableCodes(): string[] {
  const table = screen.getByRole("table");
  return within(table)
    .queryAllByRole("link")
    .map((link) => link.textContent ?? "")
    .filter((text) => text !== "Full financials");
}

function region(): HTMLElement {
  return screen.getByRole("table").parentElement!;
}

function summary(): HTMLElement {
  return document.querySelector('[aria-live="polite"]') as HTMLElement;
}

beforeEach(() => {
  searchParams = new URLSearchParams("");
  fetchMock.mockReset();
  mockGetStrategyPicks.mockReset();
  global.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.useRealTimers();
});

describe("PicksSortedView: status filter (no sort, no request)", () => {
  it("shows only the filtered status", () => {
    searchParams = new URLSearchParams("status=setup");
    renderView();
    expect(tableCodes()).toEqual([SETUP.code]);
    expect(screen.getByRole("link", { name: /^Setup/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("link", { name: "Shortlist" })).not.toHaveAttribute(
      "aria-current",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("filters to triggered and to watch", () => {
    searchParams = new URLSearchParams("status=triggered");
    const { unmount } = renderView();
    expect(tableCodes()).toEqual([TRIGGERED.code]);
    unmount();

    searchParams = new URLSearchParams("status=watch");
    renderView();
    expect(tableCodes()).toEqual([WATCH.code]);
  });

  it("treats a missing or unrecognised status, and ?sort=score, as the shortlist in rank order", () => {
    searchParams = new URLSearchParams("status=everything&sort=score");
    renderView();
    expect(tableCodes()).toEqual([TRIGGERED.code, SETUP.code, WATCH.code]);
    expect(screen.getByRole("link", { name: "Shortlist" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("link", { name: "Rank" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps watch rows out of a shortlist that is already full", () => {
    const setups = Array.from({ length: 20 }, (_, i) =>
      pick({
        code: `S${String(i).padStart(2, "0")}`,
        rank: i + 1,
        status: "setup",
      }),
    );
    renderView([...setups, { ...WATCH, rank: 21 }]);
    const codes = tableCodes();
    expect(codes).toHaveLength(20);
    expect(codes).not.toContain(WATCH.code);
  });

  it("says so, rather than rendering an empty table, when a status has no rows", () => {
    searchParams = new URLSearchParams("status=triggered");
    renderView([SETUP, WATCH]);
    expect(
      screen.getByText("No stocks are at triggered status today."),
    ).toBeInTheDocument();
  });

  it("links every chip to a URL and marks counts cut off by the row limit", () => {
    renderView([TRIGGERED, SETUP], 250);
    const nav = screen.getByRole("navigation", {
      name: "Filter picks by status",
    });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/picks/zanger-breakout",
      "/picks/zanger-breakout?status=triggered",
      "/picks/zanger-breakout?status=setup",
      "/picks/zanger-breakout?status=watch",
    ]);
    expect(
      within(nav).getByRole("link", { name: /^Triggered/ }),
    ).toHaveTextContent("Triggered1");
    expect(within(nav).getByRole("link", { name: /^Setup/ })).toHaveTextContent(
      "Setup1+",
    );
    for (const chip of within(nav).getAllByRole("link")) {
      expect(chip).toHaveAttribute("rel", "nofollow");
    }
  });
});

describe("PicksSortedView: sorting", () => {
  it("keeps ?sort= on the status chips and ?status= on the sort chips", () => {
    searchParams = new URLSearchParams("status=setup&sort=roe");
    fetchMock.mockReturnValue(new Promise(() => undefined));
    renderView();
    const status = screen.getByRole("navigation", {
      name: "Filter picks by status",
    });
    expect(
      within(status)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/picks/zanger-breakout?sort=roe",
      "/picks/zanger-breakout?status=triggered&sort=roe",
      "/picks/zanger-breakout?status=setup&sort=roe",
      "/picks/zanger-breakout?status=watch&sort=roe",
    ]);
    const sort = screen.getByRole("navigation", { name: "Sort picks" });
    const hrefs = within(sort)
      .getAllByRole("link")
      .map((a) => a.getAttribute("href"));
    expect(hrefs[0]).toBe("/picks/zanger-breakout?status=setup");
    expect(hrefs).toContain("/picks/zanger-breakout?status=setup&sort=pe");
    expect(within(sort).getByRole("link", { name: "ROE" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    for (const chip of within(sort).getAllByRole("link")) {
      expect(chip).toHaveAttribute("rel", "nofollow");
    }
  });

  it("POSTs plain JSON through the rewrite, dims the server rows while it loads, then shows the API's order", async () => {
    searchParams = new URLSearchParams("sort=roe");
    let resolve: (value: unknown) => void = () => undefined;
    fetchMock.mockReturnValue(new Promise((r) => (resolve = r)));
    renderView();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(GET_STRATEGY_PICKS_PATH);
    expect(url).toBe("/shorts.v1alpha1.StrategyService/GetStrategyPicks");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      strategyId: "zanger-breakout",
      sortBy: "roe",
      status: "",
      limit: 100,
    });

    // Loading: the server rows, dimmed and aria-busy.
    expect(region()).toHaveAttribute("aria-busy", "true");
    expect(tableCodes()).toEqual([TRIGGERED.code, SETUP.code, WATCH.code]);
    expect(summary()).toHaveTextContent(/^Sorting by ROE\./);

    const answer = {
      ...PROTOJSON_PICKS,
      // The API's ROE order: PLS has no figure, so it comes last.
      picks: [
        PROTOJSON_PICKS.picks[0],
        { ...PROTOJSON_PICKS.picks[1], rank: 2 },
      ],
    };
    await act(async () => resolve(jsonResponse(answer)));

    expect(region()).not.toHaveAttribute("aria-busy");
    expect(tableCodes()).toEqual(["BHP", "PLS"]);
    expect(summary()).toHaveTextContent(
      "Top 2 of 57 by ROE. Stocks without the figure come last.",
    );
    expect(
      screen.getByRole("columnheader", { name: "Sorted by ROE" }),
    ).toBeInTheDocument();
  });

  it("sorts within the selected status", async () => {
    searchParams = new URLSearchParams("status=setup&sort=market_cap");
    fetchMock.mockResolvedValue(
      jsonResponse({
        ...PROTOJSON_PICKS,
        picks: [PROTOJSON_PICKS.picks[1]],
        totalCount: 7,
      }),
    );
    renderView();
    await screen.findByText(/Top 1 of 7 by market cap\. Setup stocks only\./);
    expect(
      JSON.parse(fetchMock.mock.calls[0]![1].body as string),
    ).toMatchObject({
      status: "setup",
      sortBy: "market_cap",
    });
  });

  it("keeps the server rows and says so when the API answers with an error", async () => {
    searchParams = new URLSearchParams("sort=pe");
    fetchMock.mockResolvedValue(jsonResponse({ code: "unavailable" }, 503));
    renderView();
    await screen.findByText("Sorting is unavailable right now.");
    expect(tableCodes()).toEqual([TRIGGERED.code, SETUP.code, WATCH.code]);
    expect(region()).not.toHaveAttribute("aria-busy");
    expect(
      screen.queryByRole("columnheader", { name: /Sorted by/ }),
    ).not.toBeInTheDocument();
  });

  it(`gives up after ${SORT_TIMEOUT_MS / 1000} s and keeps the server rows`, async () => {
    jest.useFakeTimers();
    searchParams = new URLSearchParams("sort=net_margin");
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    renderView();
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(
      screen.queryByText("Sorting is unavailable right now."),
    ).not.toBeInTheDocument();

    await act(async () => {
      jest.advanceTimersByTime(SORT_TIMEOUT_MS);
    });
    expect(
      await screen.findByText("Sorting is unavailable right now."),
    ).toBeInTheDocument();
    expect(tableCodes()).toEqual([TRIGGERED.code, SETUP.code, WATCH.code]);
  });

  it("sorts an older API's rank-ordered answer itself, and says which rows those are", async () => {
    searchParams = new URLSearchParams("sort=market_cap");
    // No fundamentals, no fundamentals_rows_count, rank order: an API that
    // predates sort_by.
    fetchMock.mockResolvedValue(
      jsonResponse({
        picks: [
          {
            rank: 1,
            stockCode: "AAA",
            status: "setup",
            marketCap: 1e9,
            hasMarketCap: true,
          },
          {
            rank: 2,
            stockCode: "BBB",
            status: "watch",
            marketCap: 5e9,
            hasMarketCap: true,
          },
          { rank: 3, stockCode: "CCC", status: "watch" },
        ],
        totalCount: 140,
      }),
    );
    renderView();
    await screen.findByText(
      "The first 3 of 140 by rank, sorted by market cap.",
    );
    expect(tableCodes()).toEqual(["BBB", "AAA", "CCC"]);
  });
});

// ONE mapper (docs/plans/fundamentals-coverage.md §7.2): the same protojson
// through the server action and through the island's fetch yields the same
// rows.
describe("one mapper for the server action and the sort island", () => {
  it("maps one protojson fixture identically on both paths", async () => {
    mockGetStrategyPicks.mockResolvedValue(PROTOJSON_PICKS);
    fetchMock.mockResolvedValue(jsonResponse(PROTOJSON_PICKS));

    const server = await getStrategyPicks("zanger-breakout");
    const island = await fetchSortedPicks({
      strategyId: "zanger-breakout",
      sortBy: "roe",
      status: null,
    });

    expect(server).not.toBeNull();
    expect(island.clientSorted).toBe(false);
    expect(island.rows).toEqual(server!.picks);
    expect(island.totalCount).toBe(server!.totalCount);
    expect(server!.fundamentalsRowsCount).toBe(1203);

    const [bhp, pls] = island.rows;
    expect(bhp!.fundamentals).toEqual({
      revenueBasis: "annual",
      revenueEnd: "2026-06-30",
      epsBasis: "half",
      epsEnd: "2025-12-31",
      epsFiling: true,
      currency: "USD",
      fetchedOn: "2026-09-27",
      netMarginPct: 18.2,
      roePct: 21.4,
      netDebtToEbitda: 0.4,
    });
    expect(pls!.fundamentals).toBeUndefined();
    // Omitted by protojson, flagged real: a measured zero short position.
    expect(pls!.shortPct).toBe(0);
    expect(pls!.revenueYoyPct).toBeNull();
    // The server action asked for the default rank order, under the v2 key.
    expect(mockGetStrategyPicks.mock.calls[0]![0]).toEqual({
      strategyId: "zanger-breakout",
      limit: 100,
      offset: 0,
      status: "",
    });
  });
});
