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
  listAgencyPriceStats: jest.fn().mockResolvedValue({ agencies: [{ agencyId: "a1" }] }),
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

const ts = (iso: string) => ({ seconds: BigInt(Math.floor(Date.parse(iso) / 1000)), nanos: 0 });

function jsonLd(container: HTMLElement): Record<string, unknown> {
  const script = container.querySelector('script[type="application/ld+json"]');
  return JSON.parse(script?.textContent ?? "{}") as Record<string, unknown>;
}

describe("PriceDropsPage freshness", () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: new Date("2026-09-24T00:00:00Z") });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // The crawl stopped on 2026-09-15 and the page kept presenting "the last 30
  // days" with no date anywhere. It must say what date the data runs to, and
  // warn once that is more than 72 hours old.
  it("dates the data and warns when it is stale", async () => {
    getPriceDropsOverview.mockResolvedValue({
      national: { totalActiveListings: 100, catalogSuburbs: 500 },
      states: [],
      asOf: ts("2026-09-15T02:00:00Z"),
      dataThrough: ts("2026-09-15T01:46:00Z"),
    });
    const { container } = render(await PriceDropsPage());

    expect(screen.getByTestId("price-drops-data-to")).toHaveTextContent("Data to 15 Sep 2026");
    expect(screen.getByTestId("price-drops-stale")).toHaveTextContent(/runs to 15 Sep 2026, not to today/);
    const ld = jsonLd(container);
    expect(ld.dateModified).toBe("2026-09-15T02:00:00.000Z");
    expect(ld.license).toBe("https://shorted.com.au/terms");
  });

  it("shows no banner for fresh data", async () => {
    getPriceDropsOverview.mockResolvedValue({
      national: { totalActiveListings: 100, catalogSuburbs: 500 },
      states: [],
      asOf: ts("2026-09-23T02:00:00Z"),
      dataThrough: ts("2026-09-23T01:00:00Z"),
    });
    render(await PriceDropsPage());

    expect(screen.getByTestId("price-drops-data-to")).toHaveTextContent("Data to 23 Sep 2026");
    expect(screen.queryByTestId("price-drops-stale")).not.toBeInTheDocument();
  });

  it("claims no date it does not have", async () => {
    getPriceDropsOverview.mockResolvedValue({ national: { totalActiveListings: 100 }, states: [] });
    const { container } = render(await PriceDropsPage());

    expect(screen.queryByTestId("price-drops-data-to")).not.toBeInTheDocument();
    expect(screen.queryByTestId("price-drops-stale")).not.toBeInTheDocument();
    expect(jsonLd(container).dateModified).toBeUndefined();
  });

  // Copy the audit found wrong: the catalog is 500 suburbs across five states
  // (including peri-urban fringes), not "~115 metro suburbs" in "five mainland
  // capitals"; only REA carries agencies.
  it("describes the catalog and the agency source accurately", async () => {
    getPriceDropsOverview.mockResolvedValue({
      national: { totalActiveListings: 100, catalogSuburbs: 500 },
      states: [],
    });
    const { container } = render(await PriceDropsPage());
    const text = container.textContent ?? "";

    expect(text).toContain("a 500-suburb catalog");
    expect(text).not.toMatch(/five mainland\s+capitals/);
    expect(text).not.toContain("~115");
  });
});

describe("PriceDropsPage agency copy", () => {
  it("says agencies come from realestate.com.au only", async () => {
    getPriceDropsOverview.mockResolvedValue({ national: { totalActiveListings: 100 }, states: [] });
    render(await PriceDropsPage());
    expect(screen.getByText(/Agencies come from realestate\.com\.au listings only/)).toBeInTheDocument();
    expect(screen.queryByText(/may appear once per portal/)).not.toBeInTheDocument();
  });
});

describe("PriceDropsPage empty but dated", () => {
  // 000124 gates "active" on a 14-day sighting, so an outage longer than that
  // legitimately empties the rollup. That is not "loading".
  it("explains an empty rollup instead of promising data", async () => {
    getPriceDropsOverview.mockResolvedValue({
      national: { totalActiveListings: 0 },
      states: [],
      asOf: ts("2026-10-05T02:00:00Z"),
      dataThrough: ts("2026-09-15T01:46:00Z"),
    });
    render(await PriceDropsPage());
    // data_through IS the newest sighting, so listings were seen on that day:
    // the page must say "since", never "in the 14 days to" it.
    expect(screen.getByText(/No listing has been seen since 15 Sep 2026\./)).toBeInTheDocument();
    expect(screen.queryByText(/in the 14 days to/)).not.toBeInTheDocument();
    expect(screen.queryByText(/check back shortly/)).not.toBeInTheDocument();
  });
});

describe("PriceDropsPage kill switch", () => {
  // A takedown empties every crawl-derived read on purpose. It is not
  // "loading", and it must not force every request to render uncached.
  it("says the figures are unavailable and keeps the render cacheable", async () => {
    const { bailOnEmptyRender } = jest.requireMock("~/app/actions/config") as {
      bailOnEmptyRender: jest.Mock;
    };
    bailOnEmptyRender.mockClear();
    getPriceDropsOverview.mockResolvedValue({ states: [], withheld: true });
    render(await PriceDropsPage());

    expect(screen.getByText("Price-drop figures are not available at the moment.")).toBeInTheDocument();
    expect(screen.queryByText(/check back shortly/)).not.toBeInTheDocument();
    expect(bailOnEmptyRender).not.toHaveBeenCalled();
  });

  it("still bails a cold, empty fetch out of the route cache", async () => {
    const { bailOnEmptyRender } = jest.requireMock("~/app/actions/config") as {
      bailOnEmptyRender: jest.Mock;
    };
    bailOnEmptyRender.mockClear();
    getPriceDropsOverview.mockResolvedValue(undefined);
    render(await PriceDropsPage());

    expect(screen.getByText(/check back shortly/)).toBeInTheDocument();
    expect(bailOnEmptyRender).toHaveBeenCalled();
  });
});
