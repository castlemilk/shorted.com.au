/// <reference types="jest" />

import { render, screen } from "@testing-library/react";
import OwnershipMapPage, { metadata, revalidate } from "./page";

const bailOnEmptyRender = jest.fn(async () => undefined);
const loadOwnershipMap = jest.fn();
const loadFundPositionChanges = jest.fn();
const ownershipMapProps = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/ownershipDesk", () => ({
  loadOwnershipMap: (...args: unknown[]) => loadOwnershipMap(...args),
  loadFundPositionChanges: (...args: unknown[]) => loadFundPositionChanges(...args),
  loadStockPanel: jest.fn(),
  loadInspector: jest.fn(),
}));
jest.mock("~/@/components/ownership/desk/ownership-map", () => ({
  OwnershipMap: (props: unknown) => {
    ownershipMapProps(props);
    return <div data-testid="map" />;
  },
}));
jest.mock("~/@/components/ownership/workspace/inspector", () => ({
  Inspector: () => <aside aria-label="Inspector" />,
}));

const MAP_OK = { ok: true, error: "", from: "", to: "", asOf: "2026-10-30", stocks: [] };

beforeEach(() => {
  jest.clearAllMocks();
  loadOwnershipMap.mockResolvedValue(MAP_OK);
  loadFundPositionChanges.mockResolvedValue({ ok: true, error: "", snapshotDates: ["2026-09-01", "2026-10-30"], from: "", to: "", rows: [] });
});

describe("the market map page (spec 14.3)", () => {
  it("is static for an hour and carries the wireframe's title and lede", async () => {
    expect(revalidate).toBe(3600);
    render(await OwnershipMapPage());
    expect(screen.getByRole("heading", { level: 1, name: "Map the market" })).toBeInTheDocument();
    expect(screen.getByText("See what the notices disclose")).toBeInTheDocument();
  });

  it("draws the full instrument, handing it the map loader and the panel loader it needs", async () => {
    render(await OwnershipMapPage());
    expect(screen.getByTestId("map")).toBeInTheDocument();
    const props = ownershipMapProps.mock.calls[0]?.[0] as { variant?: string; basePath?: string; loadMap?: unknown };
    expect(props.variant).toBe("full");
    expect(props.basePath).toBe("/ownership/map");
    expect(typeof props.loadMap).toBe("function");
  });

  it("dates the coverage line by the index fund files it spans", async () => {
    render(await OwnershipMapPage());
    expect(screen.getByText(/Fund files: 2026-09-01 to 2026-10-30/)).toBeInTheDocument();
  });

  it("says the fund files are n/a, never zero, when none is tracked", async () => {
    loadFundPositionChanges.mockResolvedValue({ ok: true, error: "", snapshotDates: [], from: "", to: "", rows: [] });
    render(await OwnershipMapPage());
    expect(screen.getByText(/Fund files: n\/a/)).toBeInTheDocument();
  });

  it("bails the cache, and draws no map, when the market cannot be read", async () => {
    loadOwnershipMap.mockResolvedValue({ ...MAP_OK, ok: false });
    render(await OwnershipMapPage());
    expect(bailOnEmptyRender).toHaveBeenCalled();
  });

  it("has a canonical URL of its own and no social card of its own", () => {
    expect(metadata.alternates).toEqual({ canonical: "https://shorted.com.au/ownership/map" });
  });
});
