import { render, screen } from "@testing-library/react";

import HousingCalculatorsPage from "./page";
import { resolvePrefill } from "./prefill";

const getHousingOverview = jest.fn();
const bailOnEmptyRender = jest.fn();
const query: { params: URLSearchParams; suspend: boolean } = {
  params: new URLSearchParams(),
  suspend: false,
};

jest.mock("next/navigation", () => ({
  // A static render cannot read the query: useSearchParams suspends to the
  // nearest Suspense boundary, and the boundary's fallback is what the HTML
  // carries. Suspending here reproduces that markup.
  useSearchParams: () => {
    if (query.suspend) throw new Promise(() => undefined);
    return query.params;
  },
}));
jest.mock("~/app/actions/getHousing", () => ({
  getHousingOverview: (...args: unknown[]) => getHousingOverview(...args),
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("@/components/seo/llm-meta", () => ({ LLMMeta: () => null }));
jest.mock("@/components/housing/housing-icon", () => ({ HousingIcon: () => null }));
jest.mock("@/components/housing/calculators/calculators", () => ({
  MortgageSimulator: ({ initialLoan }: { initialLoan: number }) => (
    <div data-testid="mortgage" data-loan={initialLoan} />
  ),
  DepositCalculator: ({ initialPrice, initialState }: { initialPrice: number; initialState: string }) => (
    <div data-testid="deposit" data-price={initialPrice} data-state={initialState} />
  ),
  StampDutyCalculator: ({ initialPrice, initialState }: { initialPrice: number; initialState: string }) => (
    <div data-testid="stamp-duty" data-price={initialPrice} data-state={initialState} />
  ),
  RentVsBuyCalculator: ({ initialPrice, initialState }: { initialPrice: number; initialState: string }) => (
    <div data-testid="rent-vs-buy" data-price={initialPrice} data-state={initialState} />
  ),
}));

const NATIONAL = { regionCode: "AUS", measure: "mean_price", value: 1_043_210 };

function startingValues() {
  return {
    loan: screen.getByTestId("mortgage").getAttribute("data-loan"),
    prices: ["deposit", "stamp-duty", "rent-vs-buy"].map((id) =>
      screen.getByTestId(id).getAttribute("data-price"),
    ),
    states: ["deposit", "stamp-duty", "rent-vs-buy"].map((id) =>
      screen.getByTestId(id).getAttribute("data-state"),
    ),
  };
}

describe("/housing/calculators", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    query.params = new URLSearchParams();
    query.suspend = false;
    getHousingOverview.mockResolvedValue({ metrics: [NATIONAL] });
  });

  // The page used to read searchParams on the server, which rendered it per
  // request (`private, no-store`, 2026-10-21). The HTML must still be the
  // canonical URL's: the default note, its /housing link, and the calculators
  // started from the live national default.
  it("serves the unprefilled page as its static HTML", async () => {
    query.suspend = true;

    render(await HousingCalculatorsPage());

    expect(screen.getByText(/Defaults start from the national mean dwelling price/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "house-prices dashboard" })).toHaveAttribute("href", "/housing");
    expect(screen.queryByText(/Prefilled with/)).not.toBeInTheDocument();
    expect(startingValues()).toEqual({
      loan: "830000",
      prices: ["1040000", "1040000", "1040000"],
      states: ["NSW", "NSW", "NSW"],
    });
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("applies a suburb page's ?price=&state= in the browser", async () => {
    query.params = new URLSearchParams("price=750000&state=vic");

    render(await HousingCalculatorsPage());

    expect(screen.getByText("$750,000")).toBeInTheDocument();
    expect(screen.getByText(/in VIC from the suburb you came from\./)).toBeInTheDocument();
    expect(startingValues()).toEqual({
      loan: "600000",
      prices: ["750000", "750000", "750000"],
      states: ["VIC", "VIC", "VIC"],
    });
  });

  it("starts from $1m, cached for a minute, when the national price cannot be read", async () => {
    getHousingOverview.mockResolvedValue(undefined);

    render(await HousingCalculatorsPage());

    expect(bailOnEmptyRender).toHaveBeenCalledTimes(1);
    expect(startingValues().prices).toEqual(["1000000", "1000000", "1000000"]);
  });
});

describe("resolvePrefill", () => {
  const prefill = (search: string) => resolvePrefill(new URLSearchParams(search), 1_040_000);

  it("starts from the live default without a query", () => {
    expect(resolvePrefill(null, 1_040_000)).toEqual({
      price: 1_040_000,
      state: "NSW",
      initialLoan: 830_000,
      prefilled: false,
      stateGiven: false,
    });
  });

  it("rounds a price to $1k and clamps it to $100k-$5m", () => {
    expect(prefill("price=612345").price).toBe(612_000);
    expect(prefill("price=20000").price).toBe(100_000);
    expect(prefill("price=90000000").price).toBe(5_000_000);
  });

  it("falls back to the default price and NSW for values it cannot use", () => {
    expect(prefill("price=abc&state=zz")).toMatchObject({
      price: 1_040_000,
      state: "NSW",
      prefilled: true,
      stateGiven: true,
    });
    expect(prefill("price=-5").price).toBe(1_040_000);
  });

  it("bounds the mortgage loan at $50k-$3m", () => {
    expect(prefill("price=100000").initialLoan).toBe(80_000);
    expect(prefill("price=5000000").initialLoan).toBe(3_000_000);
  });
});
