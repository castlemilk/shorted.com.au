/// <reference types="jest" />

import { render, screen } from "@testing-library/react";
import OwnershipMapPage, { metadata, revalidate } from "./page";

const bailOnEmptyRender = jest.fn(async () => undefined);
const loadOwnershipMap = jest.fn();
const ownershipMapProps = jest.fn();

jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
jest.mock("~/app/actions/config", () => ({
  bailOnEmptyRender: () => bailOnEmptyRender(),
}));
jest.mock("~/app/actions/ownershipDesk", () => ({
  loadOwnershipMap: (...args: unknown[]) => loadOwnershipMap(...args),
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

// The map's own answer carries the fund comparison (spec 14.10): two funds, files 2026-09-01 against 2026-10-30.
const MAP_OK = {
  ok: true,
  error: "",
  from: "",
  to: "",
  asOf: "2026-10-30",
  stocks: [],
  fundsCompared: 2,
  startFilesFrom: "2026-09-01",
  startFilesTo: "2026-09-01",
  endFilesFrom: "2026-10-30",
  endFilesTo: "2026-10-30",
};

beforeEach(() => {
  jest.clearAllMocks();
  loadOwnershipMap.mockResolvedValue(MAP_OK);
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

  it("leaves the fund comparison to the map, which draws it from the answer it holds, not the default window", async () => {
    loadOwnershipMap.mockResolvedValue({ ...MAP_OK, fundsCompared: 2 });
    render(await OwnershipMapPage());
    expect(screen.queryByText(/funds compared/)).toBeNull();
    expect(screen.getByText(/Default window · Latest available/)).toBeInTheDocument();
  });

  it("keeps the method in the sources section, which the insights page's paragraphs now sit in", async () => {
    const { container } = render(await OwnershipMapPage());
    const section = container.querySelector("section[aria-labelledby='sources']");
    expect(section).not.toBeNull();
    expect(section?.textContent).toMatch(/valued at its own later file's price .* so a price move is not a position move/);
    expect(section?.textContent).toMatch(/A notice is dated by the day ASX released it/);
    expect(section?.querySelector('a[href="/ownership/activity"]')?.textContent).toBe("sector heatmap on Activity");
    expect(section?.textContent).toMatch(/its file at the window's start \(or its first file inside the window\)/);
    expect(section?.textContent).toMatch(/what the notices disclose, not a share of the company/);
    expect(screen.getByRole("heading", { name: "Sources and method" })).toBeInTheDocument();
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
