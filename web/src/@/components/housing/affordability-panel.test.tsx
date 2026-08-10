import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { AffordabilityPanel } from "./affordability-panel";

const mockSeriesChart = jest.fn((props: Record<string, unknown>) => (
  <div role="img" aria-label={String(props.ariaLabel)} data-measure={props.measure} />
));
const mockComparisonChart = jest.fn((props: Record<string, unknown>) => (
  <div role="img" aria-label={String(props.ariaLabel)} />
));

jest.mock("./housing-charts", () => ({
  HousingSeriesChart: (props: Record<string, unknown>) => mockSeriesChart(props),
  HousingComparisonChart: (props: Record<string, unknown>) =>
    mockComparisonChart(props),
}));

jest.mock("./when-visible", () => ({
  WhenVisible: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="when-visible">{children}</div>
  ),
}));

describe("AffordabilityPanel", () => {
  beforeEach(() => {
    mockSeriesChart.mockClear();
    mockComparisonChart.mockClear();
  });

  it("keeps the panel server-renderable and every chart definition serializable", () => {
    const source = readFileSync(
      join(process.cwd(), "src/@/components/housing/affordability-panel.tsx"),
      "utf8",
    );
    expect(source.trimStart()).not.toMatch(/^['\"]use client['\"]/);

    render(<AffordabilityPanel />);

    for (const [props] of [
      ...mockSeriesChart.mock.calls,
      ...mockComparisonChart.mock.calls,
    ]) {
      expect(() => JSON.stringify(props)).not.toThrow();
      expect(props).not.toEqual(
        expect.objectContaining({ formatValue: expect.any(Function) }),
      );
    }
  });

  it("surfaces all thirteen national measures through lazy chart gates", () => {
    render(<AffordabilityPanel />);

    expect(
      screen.getByRole("heading", { name: "Affordability & credit" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Rates & credit" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Affordability" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Household balance sheet" }),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("when-visible")).toHaveLength(7);

    const singleMeasures = mockSeriesChart.mock.calls.map(
      ([props]) => props.measure,
    );
    const comparisonMeasures = mockComparisonChart.mock.calls.flatMap(
      ([props]) =>
        (props.definitions as ReadonlyArray<{ measure: string }>).map(
          ({ measure }) => measure,
        ),
    );
    expect([...singleMeasures, ...comparisonMeasures].sort()).toEqual(
      [
        "cash_rate",
        "household_dwelling_assets",
        "household_liabilities",
        "household_net_worth",
        "housing_credit_growth",
        "housing_credit_growth_investor",
        "housing_credit_growth_oo",
        "investor_loan_share",
        "mortgage_rate_investor",
        "mortgage_rate_oo",
        "price_to_income",
        "rents_index",
        "wage_index",
      ].sort(),
    );

    for (const [props] of [
      ...mockSeriesChart.mock.calls,
      ...mockComparisonChart.mock.calls,
    ]) {
      expect(props.regionCode).toBe("AUS");
    }

    expect(mockComparisonChart).toHaveBeenCalledWith(
      expect.objectContaining({
        transform: "yoy",
        format: "percent",
        definitions: [
          { measure: "rents_index", label: "Rents" },
          { measure: "wage_index", label: "Wages" },
        ],
      }),
    );
  });

  it("labels measure cadence, units, sources, tables, and licences", () => {
    render(<AffordabilityPanel />);

    expect(screen.getByText("Monthly · % p.a.")).toBeInTheDocument();
    expect(screen.getByText("Monthly · annual % change")).toBeInTheDocument();
    expect(
      screen.getByText("Monthly/quarterly · index, YoY & share"),
    ).toBeInTheDocument();
    expect(screen.getByText("Quarterly · AUD")).toBeInTheDocument();

    expect(
      screen.getByText("Source: RBA Tables F1.1 & F6 · CC BY 4.0"),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Source: RBA Table D1 · CC BY 4.0"),
    ).toHaveLength(2);
    expect(
      screen.getByText("Source: ABS CPI and WPI · CC BY 4.0"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Source: Shorted-derived from ABS RES_DWELL_ST and WPI · CC BY 4.0",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Source: ABS LEND_HOUSING · CC BY 4.0"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Source: RBA Table E1 · CC BY 4.0"),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/CC BY 4\.0$/)).toHaveLength(7);
  });
});
