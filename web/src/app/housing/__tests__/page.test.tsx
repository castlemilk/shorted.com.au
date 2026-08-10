import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { getHousingOverview } from "~/app/actions/getHousing";
import HousingPage, { revalidate } from "../page";

const mockHousingSeriesChart = jest.fn((props: Record<string, unknown>) => (
  <div role="img" aria-label={String(props.ariaLabel)} data-measure={props.measure} />
));

jest.mock("~/app/actions/getHousing", () => ({
  getHousingOverview: jest.fn(),
}));

jest.mock("react-dom", () => ({
  ...jest.requireActual<typeof import("react-dom")>("react-dom"),
  preload: jest.fn(),
}));

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

jest.mock("@/components/seo/llm-meta", () => ({ LLMMeta: () => null }));
jest.mock("@/components/housing/housing-zoom-map-loader", () => ({
  HousingZoomMap: () => <div>Housing map</div>,
}));
jest.mock("@/components/housing/suburb-price-drops-panel-loader", () => ({
  SuburbPriceDropsPanel: () => <div>Price drops</div>,
}));
jest.mock("@/components/housing/housing-tiles", () => ({
  HousingTiles: () => <div>Housing tiles</div>,
}));
jest.mock("@/components/housing/housing-icon", () => ({
  HousingIcon: () => null,
}));
jest.mock("@/components/housing/when-visible", () => ({
  WhenVisible: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
jest.mock("@/components/housing/housing-charts", () => ({
  HousingSeriesChart: (props: Record<string, unknown>) =>
    mockHousingSeriesChart(props),
}));
jest.mock("@/components/housing/affordability-panel", () => ({
  AffordabilityPanel: () => <section>Affordability panel</section>,
}));

const mockedGetHousingOverview = jest.mocked(getHousingOverview);

describe("/housing affordability integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedGetHousingOverview.mockResolvedValue({
      metrics: [
        {
          regionCode: "AUS",
          regionName: "Australia",
          regionType: "national",
          stateCode: "",
          measure: "mean_price",
          dwellingType: "all",
          value: 1_020_000,
          unit: "AUD",
          isPreliminary: false,
          qoqPct: 1.2,
          yoyPct: 5.4,
        },
        {
          regionCode: "AUS",
          regionName: "Australia",
          regionType: "national",
          stateCode: "",
          measure: "debt_to_income",
          dwellingType: "all",
          value: 188,
          unit: "ratio",
          isPreliminary: false,
          qoqPct: 0.4,
          yoyPct: -0.7,
        },
        {
          regionCode: "AUS",
          regionName: "Australia",
          regionType: "national",
          stateCode: "",
          measure: "price_index",
          dwellingType: "all",
          value: 145.2,
          unit: "index",
          isPreliminary: false,
          qoqPct: 0,
          yoyPct: 0,
        },
        {
          regionCode: "AUS",
          regionName: "Australia",
          regionType: "national",
          stateCode: "",
          measure: "price_index_derived",
          dwellingType: "all",
          value: 128.4,
          unit: "index",
          isPreliminary: false,
          qoqPct: 1.1,
          yoyPct: 4.8,
        },
      ],
    } as Awaited<ReturnType<typeof getHousingOverview>>);
  });

  it("keeps static ISR and reads only the quarterly overview on the server", async () => {
    const source = readFileSync(
      join(process.cwd(), "src/app/housing/page.tsx"),
      "utf8",
    );
    expect(revalidate).toBe(3600);
    expect(HousingPage.length).toBe(0);
    expect(source).not.toContain("searchParams");
    expect(source).not.toContain("getHousePriceSeries");

    render(await HousingPage());

    expect(mockedGetHousingOverview).toHaveBeenCalledTimes(1);
    expect(mockedGetHousingOverview).toHaveBeenCalledWith("");
  });

  it("uses the live derived index for the headline and national chart", async () => {
    render(await HousingPage());

    expect(screen.getByText("128.4")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Shorted rebase of ABS national mean dwelling prices · first quarter = 100",
      ),
    ).toBeInTheDocument();
    expect(mockHousingSeriesChart).toHaveBeenCalledWith(
      expect.objectContaining({
        regionCode: "AUS",
        measure: "price_index_derived",
        format: "index",
        ariaLabel: "National dwelling price index",
      }),
    );
    expect(
      screen.getByText(
        "Shorted-derived from ABS RES_DWELL_ST · earliest quarter = 100 · CC BY 4.0",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Affordability panel")).toBeInTheDocument();
    expect(screen.queryByText(/RPPI|8-capital|to 2021/i)).not.toBeInTheDocument();
  });
});
