import { describe, it, expect } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import {
  FinancialDigest,
  formatMetricValue,
} from "../financial-digest";
import type { StockFinancialHighlight } from "~/app/actions/reports/getReportData";

describe("formatMetricValue", () => {
  describe("aggregate metrics (value_millions)", () => {
    it("formats revenue of 624 million as $624M", () => {
      expect(formatMetricValue("revenue", { value_millions: "624" })).toBe(
        "$624M",
      );
    });

    it("formats revenue of 1540 million as $1.54B", () => {
      expect(formatMetricValue("revenue", { value_millions: "1540" })).toBe(
        "$1.54B",
      );
    });

    it("formats net_profit from value_millions", () => {
      expect(formatMetricValue("net_profit", { value_millions: "5142" })).toBe(
        "$5.14B",
      );
    });

    it("supports value_billions as an aggregate fallback", () => {
      expect(formatMetricValue("revenue", { value_billions: "1.2" })).toBe(
        "$1.20B",
      );
      expect(formatMetricValue("revenue", { value_billions: "0.5" })).toBe(
        "$500M",
      );
    });

    it("formats negative aggregates with a leading sign", () => {
      expect(formatMetricValue("net_profit", { value_millions: "-624" })).toBe(
        "-$624M",
      );
    });
  });

  describe("per-share metrics (value_cents)", () => {
    it("formats eps of 235 cents as $2.35", () => {
      expect(formatMetricValue("eps", { value_cents: "235" })).toBe("$2.35");
    });

    it("formats a 50c dividend as $0.50 (never through the B/M ladder)", () => {
      expect(formatMetricValue("dividend", { value_cents: "50" })).toBe(
        "$0.50",
      );
    });

    it("falls back to a dollar `value` for per-share metrics", () => {
      expect(formatMetricValue("eps", { value: "2.35" })).toBe("$2.35");
    });

    it("never treats a per-share value_millions-less number as billions", () => {
      // eps of $2.35 must not render as "$2.35B"
      expect(formatMetricValue("eps", { value: "2.35" })).not.toContain("B");
      expect(formatMetricValue("dividend", { value_cents: "50" })).not.toContain(
        "M",
      );
    });
  });

  describe("missing or garbage values", () => {
    it("returns null when no value keys are present", () => {
      expect(formatMetricValue("revenue", { period: "H1 FY2025" })).toBeNull();
      expect(formatMetricValue("eps", { period: "FY2025" })).toBeNull();
    });

    it("returns null for non-numeric garbage", () => {
      expect(formatMetricValue("revenue", { value_millions: "garbage" })).toBeNull();
      expect(formatMetricValue("eps", { value_cents: "n/a" })).toBeNull();
      expect(formatMetricValue("dividend", { value: "" })).toBeNull();
    });

    it("prefers an explicit pre-formatted value when present", () => {
      expect(formatMetricValue("revenue", { formatted: "$1.2B" })).toBe("$1.2B");
    });
  });
});

describe("FinancialDigest", () => {
  const baseReport: StockFinancialHighlight = {
    reportTitle: "H1 FY2025 Results",
    reportType: "financial_report",
    reportDate: "2025-02-18",
    metrics: [
      {
        metricType: "revenue",
        sourceText: "Revenue of $624 million",
        attributes: { value_millions: "624", period: "H1 FY2025" },
      },
      {
        metricType: "eps",
        sourceText: "EPS of 235 cents",
        attributes: { value_cents: "235", period: "H1 FY2025" },
      },
      {
        metricType: "dividend",
        sourceText: "dividend",
        attributes: { value_cents: "garbage" },
      },
    ],
    digest: "Revenue grew strongly over the half.",
    confidence: 0.95,
  };

  it("renders formatted key metrics and omits unparseable ones", () => {
    render(<FinancialDigest highlights={[baseReport]} />);

    expect(screen.getByText("Results summary")).toBeInTheDocument();
    expect(screen.getByText("$624M")).toBeInTheDocument();
    expect(screen.getByText("$2.35")).toBeInTheDocument();
    // The garbage dividend metric is omitted entirely
    expect(screen.queryByText("Dividend")).not.toBeInTheDocument();
  });

  it("renders nothing when no report has a digest", () => {
    const { container } = render(
      <FinancialDigest highlights={[{ ...baseReport, digest: "  " }]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
