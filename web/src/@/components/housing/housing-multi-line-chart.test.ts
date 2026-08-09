import { createElement } from "react";
import { fireEvent, render, screen, within } from "@testing-library/react";
import {
  getCombinedDomains,
  getSharedObservation,
  HousingMultiLineChart,
} from "./housing-multi-line-chart";

jest.mock("@visx/responsive", () => ({
  ParentSize: ({
    children,
  }: {
    children: (size: { width: number; height: number }) => React.ReactNode;
  }) => children({ width: 640, height: 240 }),
}));

const sparseSeries = [
  {
    label: "Cash rate",
    points: [
      { date: new Date("2024-01-01T00:00:00.000Z"), value: 4 },
      { date: new Date("2024-03-01T00:00:00.000Z"), value: 4.35 },
    ],
  },
  {
    label: "Mortgage rate",
    points: [
      { date: new Date("2024-02-01T00:00:00.000Z"), value: 6.2 },
      { date: new Date("2024-03-01T00:00:00.000Z"), value: 6.1 },
    ],
  },
];

describe("getCombinedDomains", () => {
  it("uses the time and value extents across every labelled series", () => {
    const domains = getCombinedDomains([
      {
        label: "Cash rate",
        points: [
          { date: new Date("2023-03-01T00:00:00.000Z"), value: 3.6 },
          { date: new Date("2024-03-01T00:00:00.000Z"), value: 4.35 },
        ],
      },
      {
        label: "Mortgage rate",
        points: [
          { date: new Date("2022-01-01T00:00:00.000Z"), value: 2.1 },
          { date: new Date("2025-01-01T00:00:00.000Z"), value: 6.8 },
        ],
      },
      {
        label: "Investor rate",
        points: [
          { date: new Date("2023-06-01T00:00:00.000Z"), value: 7.2 },
          { date: new Date("2024-06-01T00:00:00.000Z"), value: 6.4 },
        ],
      },
    ]);

    expect(domains?.time).toEqual([
      new Date("2022-01-01T00:00:00.000Z"),
      new Date("2025-01-01T00:00:00.000Z"),
    ]);
    expect(domains?.value[0]).toBeCloseTo(1.59);
    expect(domains?.value[1]).toBeCloseTo(7.71);
  });
});

describe("getSharedObservation", () => {
  it("selects the nearest union date and only returns exact-period points", () => {
    expect(
      getSharedObservation(
        sparseSeries,
        new Date("2024-02-10T00:00:00.000Z"),
      ),
    ).toEqual({
      date: new Date("2024-02-01T00:00:00.000Z"),
      points: [undefined, sparseSeries[1]?.points[0]],
      index: 1,
      dates: [
        new Date("2024-01-01T00:00:00.000Z"),
        new Date("2024-02-01T00:00:00.000Z"),
        new Date("2024-03-01T00:00:00.000Z"),
      ],
    });
  });
});

describe("HousingMultiLineChart accessibility", () => {
  it("provides a visible legend, labelled focusable SVG, and screen-reader summary", () => {
    render(
      createElement(HousingMultiLineChart, {
        series: sparseSeries,
        ariaLabel: "Australian housing rates",
        format: "percent",
        height: 280,
      }),
    );

    expect(screen.getByText("Cash rate")).toBeVisible();
    expect(screen.getByText("Mortgage rate")).toBeVisible();
    const chart = screen.getByRole("img", { name: "Australian housing rates" });
    expect(chart).toHaveAttribute("tabindex", "0");
    expect(chart).toHaveAttribute("aria-describedby");
    expect(
      screen.getByText(/Cash rate: latest 4.35% in Mar 2024; range Jan 2024 to Mar 2024/),
    ).toHaveClass("sr-only");
    expect(
      screen.getByText(/Mortgage rate: latest 6.1% in Mar 2024; range Feb 2024 to Mar 2024/),
    ).toBeInTheDocument();
  });

  it("selects the latest shared date on focus and navigates exact union dates", () => {
    render(
      createElement(HousingMultiLineChart, {
        series: sparseSeries,
        ariaLabel: "Australian housing rates",
        format: "percent",
        height: 280,
      }),
    );

    const chart = screen.getByRole("img", { name: "Australian housing rates" });
    fireEvent.focus(chart);

    let status = screen.getByRole("status");
    expect(within(status).getByText("Mar 2024")).toBeInTheDocument();
    expect(within(status).getByText("4.35%")).toBeInTheDocument();
    expect(within(status).getByText("6.1%")).toBeInTheDocument();

    fireEvent.keyDown(chart, { key: "ArrowLeft" });

    status = screen.getByRole("status");
    expect(within(status).getByText("Feb 2024")).toBeInTheDocument();
    expect(within(status).getByText("6.2%")).toBeInTheDocument();
    expect(within(status).getByText("—")).toBeInTheDocument();

    fireEvent.keyDown(chart, { key: "ArrowRight" });
    expect(within(screen.getByRole("status")).getByText("Mar 2024")).toBeInTheDocument();
  });
});
