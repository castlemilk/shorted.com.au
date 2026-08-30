import { render, screen, within } from "@testing-library/react";

import CapitalCitiesPage from "./page";
import { CAPITALS } from "~/@/lib/housing/capitals";

const getCapitalPrices = jest.fn();
const bailOnEmptyRender = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("~/@/components/seo/breadcrumbs", () => ({
  Breadcrumbs: () => null,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/getCapitalPrices", () => ({
  getCapitalPrices: (...args: unknown[]) => getCapitalPrices(...args),
}));

const MEDIANS: Record<string, number> = {
  "1GSYD": 1_485_000,
  "2GMEL": 850_000,
  "3GBRI": 1_150_000,
  "4GADE": 980_000,
  "5GPER": 1_000_000,
  "6GHOB": 740_000,
  "7GDAR": 750_000,
  "8ACTE": 1_071_300,
};

function series(regionCode: string, dwellingType: string, value: number) {
  return {
    regionCode,
    regionName: regionCode,
    dwellingType,
    unit: "AUD",
    source: "abs_res_dwell",
    sourceLicence: "CC-BY-4.0",
    points: [{ period: "2026-03-31", value, isPreliminary: true }],
  };
}

describe("CapitalCitiesPage", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getCapitalPrices.mockImplementation(
      (regionCode: string, restOfStateCode: string | null) => {
        const house = MEDIANS[regionCode]!;
        return Promise.resolve({
          regionCode,
          house: series(regionCode, "established_house", house),
          unit: series(regionCode, "attached", house - 100_000),
          restOfState: restOfStateCode
            ? series(restOfStateCode, "established_house", house - 200_000)
            : null,
        });
      },
    );
  });

  it("ranks all eight capitals by latest house median and shows the unit spread", async () => {
    render(await CapitalCitiesPage());

    expect(getCapitalPrices).toHaveBeenCalledTimes(8);
    for (const capital of CAPITALS) {
      expect(getCapitalPrices).toHaveBeenCalledWith(
        capital.regionCode,
        capital.restOfStateCode,
      );
    }

    const ranking = within(
      screen.getByRole("list", { name: "Capital city house prices" }),
    );
    expect(
      ranking
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Greater Sydney",
      "Greater Brisbane",
      "Australian Capital Territory",
      "Greater Perth",
      "Greater Adelaide",
      "Greater Melbourne",
      "Greater Darwin",
      "Greater Hobart",
    ]);
    expect(ranking.getByText("$1,485,000")).toBeInTheDocument();
    expect(ranking.getAllByText("House premium $100,000")).toHaveLength(8);

    for (const capital of CAPITALS) {
      expect(
        ranking.getByRole("link", { name: new RegExp(capital.name, "i") }),
      ).toHaveAttribute("href", `/housing/capitals/${capital.slug}`);
    }
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("renders an uncached fallback without throwing when no capital resolves", async () => {
    getCapitalPrices.mockResolvedValue(null);

    const page = await CapitalCitiesPage();
    expect(() => render(page)).not.toThrow();
    expect(
      screen.getByText(/Capital price data is temporarily unavailable/),
    ).toBeInTheDocument();
    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
  });
});
