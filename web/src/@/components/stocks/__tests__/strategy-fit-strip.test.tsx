import { render, screen, within } from "@testing-library/react";
import { FitStatusLine, StrategyFitStrip } from "../strategy-fit-strip";
import type {
  StockStrategyFit,
  StockStrategyFitRow,
} from "~/app/actions/getStockStrategyFit";

// next/link with the prefetch prop surfaced as data-prefetch so a test can read
// it, as the stock tab bar's tests do.
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    prefetch,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

const fit: StockStrategyFit = {
  stockCode: "BHP",
  asOf: "2026-10-07",
  inUniverse: true,
  priceFeatures: null,
  regime: null,
  fits: [
    { strategyId: "canslim", strategyName: "CAN SLIM", status: "watch", score: 41, rank: 18, totalCount: 40, rules: [], ruleColumns: [] },
    { strategyId: "zanger-breakout", strategyName: "Zanger Breakout", status: "none", score: null, rank: null, totalCount: 37, rules: [], ruleColumns: [] },
  ],
};

function row(overrides: Partial<StockStrategyFitRow> = {}): StockStrategyFitRow {
  return {
    strategyId: "canslim",
    strategyName: "CAN SLIM",
    status: "watch",
    score: 41,
    rank: 18,
    totalCount: 40,
    rules: [],
    ruleColumns: [],
    ...overrides,
  };
}

describe("StrategyFitStrip", () => {
  it("renders one row per strategy with status, score, rank and the picks link", () => {
    render(<StrategyFitStrip fit={fit} />);
    const region = screen.getByRole("region", { name: "Strategy fit" });
    expect(within(region).getByRole("link", { name: "CAN SLIM" })).toHaveAttribute("href", "/picks/canslim");
    expect(within(region).getByText("rank 18 of 40")).toBeInTheDocument();
    expect(within(region).getByText("41")).toBeInTheDocument();
    expect(within(region).getByText("Not a candidate")).toBeInTheDocument();
    expect(within(region).getByRole("link", { name: /Full strategy readings/ })).toHaveAttribute("href", "/shorts/BHP/strategy");
    expect(within(region).getByText(/Prices to 7 Oct 2026/)).toBeInTheDocument();
  });

  it("renders nothing without fits", () => {
    const { container } = render(<StrategyFitStrip fit={{ ...fit, fits: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("keeps each strategy's status, score and rank on its own row", () => {
    render(<StrategyFitStrip fit={fit} />);
    const canslim = screen.getByRole("link", { name: "CAN SLIM" }).closest("li")!;
    expect(within(canslim).getByText("Watch")).toBeInTheDocument();
    expect(within(canslim).getByText("41")).toBeInTheDocument();
    expect(within(canslim).getByText("rank 18 of 40")).toBeInTheDocument();
    expect(within(canslim).queryByText("Not a candidate")).not.toBeInTheDocument();

    const zanger = screen.getByRole("link", { name: "Zanger Breakout" }).closest("li")!;
    expect(within(zanger).getByRole("link", { name: "Zanger Breakout" })).toHaveAttribute("href", "/picks/zanger-breakout");
    expect(within(zanger).getByText("Not a candidate")).toBeInTheDocument();
    expect(within(zanger).queryByText(/Score/)).not.toBeInTheDocument();
    expect(within(zanger).queryByText(/rank/)).not.toBeInTheDocument();
  });

  it("turns off Link's own prefetch on every link", () => {
    render(<StrategyFitStrip fit={fit} />);
    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(3);
    for (const link of links) {
      expect(link).toHaveAttribute("data-prefetch", "false");
    }
  });

  it("leaves the 'Prices to' clause out when the fit has no as-of date", () => {
    render(<StrategyFitStrip fit={{ ...fit, asOf: "" }} />);
    expect(screen.queryByText(/Prices to/)).not.toBeInTheDocument();
    expect(
      screen.getByText("Mechanical readings of published rules, not recommendations"),
    ).toBeInTheDocument();
  });
});

describe("FitStatusLine", () => {
  it.each([
    ["triggered", "Triggered"],
    ["setup", "Setup"],
    ["watch", "Watch"],
  ] as const)("reads a %s candidate as the %s pill", (status, label) => {
    render(<FitStatusLine fit={row({ status })} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.queryByText("Not a candidate")).not.toBeInTheDocument();
  });

  it("rounds the score to a whole number", () => {
    render(<FitStatusLine fit={row({ score: 71.6 })} />);
    expect(screen.getByText("72")).toBeInTheDocument();
  });

  it("leaves out a score, a rank and a total the data does not have", () => {
    const { rerender } = render(<FitStatusLine fit={row({ score: null, rank: null })} />);
    expect(screen.getByText("Watch")).toBeInTheDocument();
    expect(screen.queryByText(/Score/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rank/)).not.toBeInTheDocument();

    rerender(<FitStatusLine fit={row({ totalCount: null })} />);
    expect(screen.getByText("rank 18")).toBeInTheDocument();
    expect(screen.queryByText(/ of /)).not.toBeInTheDocument();
  });

  it("never shows a score or rank for a non-candidate, even if the row carries them", () => {
    render(<FitStatusLine fit={row({ status: "none", score: 55, rank: 3 })} />);
    expect(screen.getByText("Not a candidate")).toBeInTheDocument();
    expect(screen.queryByText(/Score/)).not.toBeInTheDocument();
    expect(screen.queryByText(/rank/)).not.toBeInTheDocument();
  });
});
