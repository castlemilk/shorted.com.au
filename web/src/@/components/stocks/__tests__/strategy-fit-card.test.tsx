import { render, screen, within } from "@testing-library/react";
import type { StockStrategyFit } from "~/app/actions/getStockStrategyFit";
import { NOT_A_CANDIDATE, StrategyFitCard } from "../strategy-fit-card";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({
    children,
    href,
    prefetch: _prefetch,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    prefetch?: boolean;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

function fit(): StockStrategyFit {
  return {
    stockCode: "BHP",
    asOf: "2026-09-25",
    inUniverse: true,
    fits: [
      {
        strategyId: "zanger-breakout",
        strategyName: "Zanger Breakout",
        status: "setup",
        score: 71.6,
        rank: 4,
        totalCount: 37,
        rules: [
          { ruleId: "eps_growth", status: "pass", detail: "EPS +31% YoY (HY)" },
          { ruleId: "breakout", status: "fail", detail: "No breakout yet" },
          { ruleId: "revenue_growth", status: "unknown", detail: "" },
        ],
        ruleColumns: [
          { id: "eps_growth", title: "Earnings growth" },
          { id: "breakout", title: "Breakout" },
          { id: "revenue_growth", title: "Revenue growth" },
        ],
      },
      {
        strategyId: "canslim",
        strategyName: "CAN SLIM",
        status: "none",
        score: null,
        rank: null,
        totalCount: 12,
        rules: [{ ruleId: "market", status: "fail", detail: "XJO below its 200-day" }],
        ruleColumns: [{ id: "market", title: "Market direction" }],
      },
    ],
  };
}

describe("StrategyFitCard", () => {
  it("links every strategy crawlably with its pill, score, rank and rule dots", () => {
    render(<StrategyFitCard fit={fit()} />);
    const card = screen.getByRole("region", { name: "Strategy fit" });

    const zanger = within(card).getByRole("link", { name: "Zanger Breakout" });
    expect(zanger).toHaveAttribute("href", "/picks/zanger-breakout");
    expect(within(card).getByRole("link", { name: "CAN SLIM" })).toHaveAttribute(
      "href",
      "/picks/canslim",
    );

    const zangerRow = zanger.closest("li")!;
    expect(within(zangerRow).getByText("Setup")).toBeInTheDocument();
    expect(within(zangerRow).getByText("72")).toBeInTheDocument();
    expect(within(zangerRow).getByText("rank 4 of 37")).toBeInTheDocument();
    // The dots carry the rule title and the evidence for screen readers.
    expect(
      within(zangerRow).getByText("1. Earnings growth: pass. EPS +31% YoY (HY)"),
    ).toBeInTheDocument();
    expect(within(zangerRow).getByText("3. Revenue growth: unknown")).toBeInTheDocument();
  });

  it("reads a non-candidate as such, with no score or rank", () => {
    render(<StrategyFitCard fit={fit()} />);
    const row = screen.getByRole("link", { name: "CAN SLIM" }).closest("li")!;
    expect(within(row).getByText(NOT_A_CANDIDATE)).toBeInTheDocument();
    expect(within(row).queryByText(/rank/)).not.toBeInTheDocument();
    expect(within(row).queryByText(/Score/)).not.toBeInTheDocument();
  });

  it("carries the legend and the not-advice footer linking /disclaimer", () => {
    render(<StrategyFitCard fit={fit()} />);
    expect(screen.getByText("Pass")).toBeInTheDocument();
    expect(screen.getByText(/^Unknown/)).toBeInTheDocument();
    expect(
      screen.getByText(/Prices to 25 Sep 2026 · Mechanical readings of published rules, not recommendations ·/),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Not financial advice" })).toHaveAttribute(
      "href",
      "/disclaimer",
    );
  });

  it("renders nothing for a stock outside the universe", () => {
    const { container } = render(
      <StrategyFitCard fit={{ ...fit(), inUniverse: false, fits: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
