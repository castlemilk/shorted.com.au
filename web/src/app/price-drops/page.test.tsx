import { render, screen } from "@testing-library/react";

import PriceDropsPage from "./page";

const preload = jest.fn();
const getPriceDropsOverview = jest.fn();

jest.mock("react-dom", () => ({
  ...jest.requireActual("react-dom"),
  preload: (...args: unknown[]) => preload(...args),
}));

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));
jest.mock("@/components/housing/housing-icon", () => ({
  HousingIcon: () => null,
}));
jest.mock("@/components/housing/address-drops-board-loader", () => ({
  AddressDropsBoard: () => <div data-testid="address-board" />,
}));
jest.mock("@/components/housing/price-drops/national-pulse", () => ({
  NationalPulse: () => <div data-testid="national-pulse" />,
}));
jest.mock("@/components/housing/price-drops/state-drops-map-loader", () => ({
  StateDropsMap: ({ states }: { states: unknown[] }) => (
    <div data-testid="state-drops-map">{states.length}</div>
  ),
}));
jest.mock("@/components/housing/price-drops/state-drops-board", () => ({
  StateDropsBoard: ({ states }: { states: unknown[] }) => (
    <div data-testid="state-drops-table">{states.length}</div>
  ),
}));
jest.mock("@/components/housing/price-drops/suburb-drops-leaderboard", () => ({
  SuburbDropsLeaderboard: () => null,
}));
jest.mock("@/components/housing/price-drops/agency-drops-board", () => ({
  AgencyDropsBoard: () => null,
}));
jest.mock("@/components/seo/llm-meta", () => ({ LLMMeta: () => null }));
jest.mock("~/app/actions/config", () => ({ bailOnEmptyRender: jest.fn() }));
jest.mock("~/app/actions/getHousing", () => ({
  getPriceDropsOverview: (...args: unknown[]) => getPriceDropsOverview(...args),
  getDropIndexSeries: jest.fn().mockResolvedValue({ points: [], trackingSince: "" }),
  listAddressPriceDrops: jest.fn().mockResolvedValue({ addresses: [] }),
  listAgencyPriceStats: jest.fn().mockResolvedValue({ agencies: [] }),
  listSuburbPriceDrops: jest.fn().mockResolvedValue({ suburbs: [] }),
}));

describe("PriceDropsPage state choropleth", () => {
  beforeEach(() => {
    preload.mockClear();
    getPriceDropsOverview.mockResolvedValue({
      national: { totalActiveListings: 100 },
      states: [
        { stateCode: "NSW", droppedShare: 0.04 },
        { stateCode: "VIC", droppedShare: 0.03 },
      ],
    });
  });

  it("renders the map in addition to the crawlable table and preloads its boundaries", async () => {
    render(await PriceDropsPage());

    expect(screen.getByTestId("state-drops-map")).toHaveTextContent("2");
    expect(screen.getByTestId("state-drops-table")).toHaveTextContent("2");
    expect(preload).toHaveBeenCalledWith("/geo/states.topojson", {
      as: "fetch",
      crossOrigin: "anonymous",
    });
  });
});
