import { render, screen } from "@testing-library/react";

import { CategoricalLegend } from "./categorical-legend";
import { METRIC_BY_KEY } from "@/lib/housing/highlight-metrics";
import { OverlaySources } from "./overlay-control";

const entries = [{ label: "Low-density residential", color: "#fde68a" }];

describe("CategoricalLegend", () => {
  it("uses the metric's own no-data wording", () => {
    const zoning = METRIC_BY_KEY.dominant_zone_family;
    const noDataLabel = zoning.kind === "column-categorical" ? zoning.noDataLabel : undefined;
    expect(noDataLabel).toBe("No open zoning map covers it");
    render(<CategoricalLegend label="Largest zoning family" entries={entries} noDataLabel={noDataLabel} />);
    expect(screen.getByText("No open zoning map covers it")).toBeInTheDocument();
    expect(screen.queryByText("No data")).not.toBeInTheDocument();
  });

  it("falls back to 'No data'", () => {
    render(<CategoricalLegend label="Religion" entries={entries} />);
    expect(screen.getByText("No data")).toBeInTheDocument();
  });
});

describe("OverlaySources", () => {
  it("credits a drawn planning overlay by its source", () => {
    render(<OverlaySources stateCode="VIC" active={["zoning"]} metricKey="price" />);
    const line = screen.getByTestId("overlay-sources");
    expect(line).toHaveTextContent("CC BY");
    expect(line).toHaveTextContent("Vicmap Planning zones");
  });

  it("credits the source behind a zoning colour-by with no overlay on", () => {
    render(<OverlaySources stateCode="NSW" active={[]} metricKey="heritage_share_pct" />);
    expect(screen.getByTestId("overlay-sources")).toHaveTextContent("NSW EPI Heritage conservation areas");
  });

  it("renders nothing when no such layer is drawn", () => {
    render(<OverlaySources stateCode="NSW" active={[]} metricKey="price" />);
    expect(screen.queryByTestId("overlay-sources")).not.toBeInTheDocument();
  });
});
