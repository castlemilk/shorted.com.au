import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useSession } from "next-auth/react";

import type {
  PickRow,
  RuleResultRow,
  StatusCountsView,
} from "~/@/lib/strategies/types";
import type { SignalRule } from "~/@/lib/strategies/signals";
import { SignalsIsland, type SignalsIslandProps } from "./signals-island";
import { getSignalsForViewer } from "~/app/actions/strategies/viewer";

const mockUseSession = useSession as unknown as jest.Mock;
const mockGetSignalsForViewer = getSignalsForViewer as unknown as jest.Mock;

let search = "";
jest.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(search),
  useRouter: () => ({
    push: jest.fn(),
    replace: jest.fn(),
    prefetch: jest.fn(),
  }),
}));
// Held pending by default: a reading that resolves after a test ends would
// update the island outside act().
jest.mock("~/app/actions/getSignalStockFit", () => ({
  getSignalStockFit: jest.fn(() => new Promise(() => {})),
}));
// The signed-in list is a server action; held pending unless a test answers it.
jest.mock("~/app/actions/strategies/viewer", () => ({
  getSignalsForViewer: jest.fn(() => new Promise(() => {})),
}));
// The chart is a client-only lazy module with its own data hooks; the island
// is under test, so it is stubbed to a marker.
jest.mock("~/@/components/strategy/strategy-levels-chart-loader", () => ({
  StrategyLevelsChart: ({ stockCode }: { stockCode: string }) => (
    <div data-chart={stockCode}>chart</div>
  ),
}));

const RULES: SignalRule[] = [
  {
    id: "short_crowding",
    title: "Short crowding",
    core: true,
    trigger: false,
    evaluation: "",
    threshold: 5,
    unit: "pct",
    comparator: ">=",
  },
  {
    id: "breakout",
    title: "Breakout on heavy volume",
    core: true,
    trigger: true,
    evaluation: "A close above the prior 40-session high on heavy volume.",
    unit: "",
    comparator: "",
  },
  {
    id: "liquidity",
    title: "Liquid enough to trade",
    core: true,
    trigger: false,
    evaluation: "",
    threshold: 250_000,
    unit: "aud",
    comparator: ">=",
  },
  {
    id: "market",
    title: "Market direction",
    core: false,
    trigger: false,
    evaluation: "",
    unit: "",
    comparator: "",
  },
];

const DETAIL =
  "Short position 10.0% of shares on issue, ASIC report of 28 Oct 2026 (available 3 Nov). Above the 5% line the strategy reads as crowded.";

function pick(
  code: string,
  status: PickRow["status"],
  failBreakout: boolean,
): PickRow {
  const rules: RuleResultRow[] = [
    { ruleId: "short_crowding", status: "pass", detail: DETAIL, value: 10 },
    failBreakout
      ? { ruleId: "breakout", status: "fail", detail: DETAIL, waiting: true }
      : { ruleId: "breakout", status: "pass", detail: DETAIL },
    { ruleId: "liquidity", status: "pass", detail: DETAIL, value: 63_500_000 },
    { ruleId: "market", status: "pass", detail: DETAIL },
  ];
  return {
    rank: 1,
    code,
    name: `${code} Limited Holdings Group`,
    industry: "Software",
    status,
    score: 61.5,
    rules,
    close: 40.81,
    asOf: "2026-11-03",
    pivot: 41.64,
    baseDepthPct: 9.3,
    baseLengthDays: 22,
    volumeRatio: 1.6,
    revenueYoyPct: 12.1,
    epsYoyPct: 8.4,
    rs3mPct: 6.2,
    shortPct: 10,
    marketCap: 2_000_000_000,
    logoUrl: "",
    daysToCover: 4.8,
    shortReportDate: "2026-10-28",
    shortAvailableDate: "2026-11-03",
  } as PickRow;
}

const COUNTS: StatusCountsView = {
  triggered: 5,
  setup: 66,
  watch: 0,
  unknown: 0,
};

function props(
  overrides: Partial<SignalsIslandProps> = {},
): SignalsIslandProps {
  const rows = [
    pick("TWE", "triggered", false),
    pick("WTC", "setup", true),
    ...Array.from({ length: 8 }, (_, i) => pick(`X${i}`, "setup", true)),
  ];
  return {
    slug: "crowded-short-breakout",
    strategyName: "Crowded-Short Breakout",
    available: true,
    rules: RULES,
    rows,
    counts: COUNTS,
    total: 71,
    asOf: "2026-11-03",
    shortReportDate: "2026-10-28",
    shortAvailableDate: "2026-11-03",
    stale: false,
    version: {
      strategyId: "crowded-short-breakout",
      label: "v1",
      rulesHash: "3f9a1c2e0000",
      engineVersion: "",
      featureSet: "",
      status: "",
      liveFrom: "",
      kind: "",
      variantId: "",
    },
    regime: null,
    universeLabel: "ASX ordinary shares",
    strategies: [
      { id: "crowded-short-breakout", label: "Crowded-Short Breakout" },
    ],
    ...overrides,
  };
}

function signedOut() {
  mockUseSession.mockReturnValue({
    data: null,
    status: "unauthenticated",
    update: jest.fn(),
  });
}

function signedInAs(name = "Trader") {
  mockUseSession.mockReturnValue({
    data: { user: { id: "u1", name } },
    status: "authenticated",
    update: jest.fn(),
  });
}

/** The full list: the top ten plus two more, so the signed-in depth shows beyond row 10. */
function fullListRows(): PickRow[] {
  return [
    pick("TWE", "triggered", false),
    pick("WTC", "setup", true),
    ...Array.from({ length: 8 }, (_, i) => pick(`X${i}`, "setup", true)),
    pick("Y1", "watch", true),
    pick("Y2", "setup", true),
  ];
}

describe("SignalsIsland", () => {
  beforeEach(() => {
    search = "";
    mockGetSignalsForViewer.mockClear();
    signedOut();
  });

  it("draws the top rows, the status chips with their counts and the count line", () => {
    render(<SignalsIsland {...props()} />);
    expect(
      screen.getByRole("button", { name: /Triggered\s*5/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Setup\s*66/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Showing 10 of 71 signals: 5 triggered · 66 setup"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        name: "Find the stocks meeting your rules",
      }),
    ).toBeInTheDocument();
  });

  it("opens on the first row's evidence, and the waiting trigger reads as waiting", () => {
    render(<SignalsIsland {...props()} />);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("TWE");
    fireEvent.click(screen.getByRole("button", { name: "WTC" }));
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("WTC");
    expect(
      screen.getByText("Waiting for breakout on heavy volume"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Short report: 28 Oct · available 3 Nov"),
    ).toBeInTheDocument();
  });

  it("reads the selection from the address and mounts the chart for it", () => {
    search = "sel=stock:WTC";
    render(<SignalsIsland {...props()} />);
    expect(screen.getByRole("heading", { level: 3 })).toHaveTextContent("WTC");
    expect(
      screen.getByText("chart", { selector: "div[data-chart='WTC']" }),
    ).toBeInTheDocument();
  });

  it("renders no gated action: no alert, compare or entry button", () => {
    render(<SignalsIsland {...props()} />);
    for (const name of [/alert/i, /compare/i, /took this entry/i, /track/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    expect(screen.getByRole("link", { name: "Open stock →" })).toHaveAttribute(
      "href",
      "/shorts/TWE/strategy",
    );
  });

  it("says the tab is unavailable when the picks read failed", () => {
    render(
      <SignalsIsland
        {...props({ available: false, rows: [], total: 0, counts: null })}
      />,
    );
    expect(screen.getByText(/temporarily unavailable/)).toBeInTheDocument();
  });

  it("asks the server for a stock the list does not hold, and prints its notice", async () => {
    const actions = jest.requireMock("~/app/actions/getSignalStockFit") as {
      getSignalStockFit: jest.Mock;
    };
    actions.getSignalStockFit.mockResolvedValueOnce({
      stockCode: "ZZZ",
      asOf: "2026-11-03",
      inUniverse: false,
      fits: [],
      priceFeatures: null,
      regime: null,
      eligible: false,
      ineligibleReason: "short_history",
      sessionDate: "2026-11-03",
    });
    search = "sel=stock:ZZZ";
    render(<SignalsIsland {...props()} />);
    await waitFor(() =>
      expect(
        screen.getByText(
          "Not evaluated on 3 Nov: not enough trading history to read its signals.",
        ),
      ).toBeInTheDocument(),
    );
    expect(actions.getSignalStockFit).toHaveBeenCalledWith("ZZZ");
  });

  it("prints an empty state, and no evidence panel, for a valid list with no stock in it", () => {
    render(<SignalsIsland {...props({ rows: [], total: 0 })} />);
    expect(
      screen.getByText(/meets Crowded-Short Breakout/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 3 })).toBeNull();
    expect(screen.queryByRole("link", { name: "Open stock →" })).toBeNull();
  });

  it("shows the sign-in prompt as the last row when the list holds more than the top rows", () => {
    render(<SignalsIsland {...props()} />);
    const link = screen.getByRole("link", { name: "Sign in free" });
    expect(link).toHaveAttribute(
      "href",
      "/signin?callbackUrl=%2Fstrategies%2Fcrowded-short-breakout%2Fsignals",
    );
    expect(
      screen.getByText(/to see all 71 signals \(5 triggered · 66 setup\)\./),
    ).toBeInTheDocument();
    expect(mockGetSignalsForViewer).not.toHaveBeenCalled();
  });

  it("omits the sign-in row when the whole list is already shown", () => {
    render(
      <SignalsIsland
        {...props({
          rows: props().rows.slice(0, 3),
          total: 3,
          counts: { triggered: 1, setup: 2, watch: 0, unknown: 0 },
        })}
      />,
    );
    expect(screen.queryByRole("link", { name: "Sign in free" })).toBeNull();
  });

  it("prompts an anonymous visitor who filters, sorts or searches, and keeps the top rows", () => {
    render(<SignalsIsland {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: /Triggered\s*5/ }));
    expect(screen.getByRole("status")).toHaveTextContent(
      /Sign in free to see all 71 signals/,
    );
    expect(screen.getByRole("button", { name: /All\s*71/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.getByText("Showing 10 of 71 signals: 5 triggered · 66 setup"),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole("combobox", { name: "Sort signals" }), {
      target: { value: "roe" },
    });
    expect(mockGetSignalsForViewer).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search stock" }), {
      target: { value: "WTC" },
    });
    expect(screen.getByRole("searchbox", { name: "Search stock" })).toHaveValue(
      "",
    );
    expect(mockGetSignalsForViewer).not.toHaveBeenCalled();
  });

  it("loads the full list for a signed-in viewer, past the top rows", async () => {
    signedInAs();
    mockGetSignalsForViewer.mockResolvedValueOnce({
      ok: true,
      rows: fullListRows(),
      totalCount: 12,
      statusCounts: { triggered: 1, setup: 10, watch: 1, unknown: 0 },
    });
    render(<SignalsIsland {...props()} />);
    expect(
      screen.getByText("Loading the full list…", { exact: false }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", { name: "Y2" }),
    ).toBeInTheDocument();
    expect(mockGetSignalsForViewer).toHaveBeenCalledWith({
      strategyId: "crowded-short-breakout",
      sortBy: "",
    });
    expect(screen.queryByRole("link", { name: "Sign in free" })).toBeNull();
    expect(
      screen.getByText("12 signals: 1 triggered · 10 setup · 1 watch"),
    ).toBeInTheDocument();
  });

  it("filters, searches and sorts the full list for a signed-in viewer", async () => {
    signedInAs();
    mockGetSignalsForViewer.mockResolvedValue({
      ok: true,
      rows: fullListRows(),
      totalCount: 12,
      statusCounts: { triggered: 1, setup: 10, watch: 1, unknown: 0 },
    });
    render(<SignalsIsland {...props()} />);
    await screen.findByRole("button", { name: "Y2" });

    fireEvent.click(screen.getByRole("button", { name: /Watch\s*1/ }));
    expect(screen.getByRole("button", { name: "Y1" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Y2" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /All\s*12/ }));

    fireEvent.change(screen.getByRole("searchbox", { name: "Search stock" }), {
      target: { value: "x3" },
    });
    expect(screen.getByRole("button", { name: "X3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "TWE" })).toBeNull();
    expect(screen.getByText("Showing 1 of 12 signals")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search stock" }), {
      target: { value: "nothing like this" },
    });
    expect(
      screen.getByText("No stock matches that search."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search stock" }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort signals" }), {
      target: { value: "roe" },
    });
    await waitFor(() =>
      expect(mockGetSignalsForViewer).toHaveBeenLastCalledWith({
        strategyId: "crowded-short-breakout",
        sortBy: "roe",
      }),
    );
  });

  it("words an empty filter for a signed-in viewer", async () => {
    signedInAs();
    mockGetSignalsForViewer.mockResolvedValueOnce({
      ok: true,
      rows: Array.from({ length: 9 }, (_, i) => pick(`S${i}`, "setup", true)),
      totalCount: 9,
      statusCounts: { triggered: 0, setup: 9, watch: 0, unknown: 0 },
    });
    render(<SignalsIsland {...props({ rows: [], total: 0, counts: null })} />);
    await screen.findByRole("button", { name: "S0" });
    fireEvent.click(screen.getByRole("button", { name: /Triggered\s*0/ }));
    expect(
      screen.getByText("No triggered stock in this list."),
    ).toBeInTheDocument();
    expect(screen.getByText("Showing 0 of 9 signals")).toBeInTheDocument();
  });

  it("keeps the top rows and says so when the full list is unavailable", async () => {
    signedInAs();
    mockGetSignalsForViewer.mockResolvedValueOnce({
      ok: false,
      reason: "unavailable",
    });
    render(<SignalsIsland {...props()} />);
    expect(
      await screen.findByText(
        /The full list is unavailable right now; showing the top rows\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "X7" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Sign in free" })).toBeNull();
  });

  it("switches strategy with links, not a select that navigates on change", () => {
    render(<SignalsIsland {...props()} />);
    expect(screen.queryByRole("combobox", { name: /strateg/i })).toBeNull();
    expect(
      screen.getByRole("link", { name: "Crowded-Short Breakout" }),
    ).toHaveAttribute("href", "/strategies/crowded-short-breakout/signals");
  });

  it("keeps the 25 KB payload budget for the ten anonymous rows", () => {
    const serialised = JSON.stringify(props());
    expect(serialised.length).toBeLessThan(25 * 1024);
  });
});
