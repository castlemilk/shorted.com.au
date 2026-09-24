import { render, screen } from "@testing-library/react";
import type { Topology } from "topojson-specification";

import { CouncilLevelMap, type CouncilMapRow } from "./council-level-map";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
// The legend is what is under test: render it and nothing else.
jest.mock("./choropleth-map", () => ({
  ChoroplethMap: ({ legend }: { legend?: React.ReactNode }) => <div data-testid="map">{legend}</div>,
}));
jest.mock("./map-legend", () => ({ MapLegend: () => null }));
jest.mock("@/lib/housing/council-geometry", () => ({
  councilTopology: (topology: unknown, objectName: string) => ({ topology, objectName, councils: 1 }),
}));

const councils: CouncilMapRow[] = [
  {
    lgaCode: "11570", slug: "canterbury-bankstown", displayName: "Canterbury-Bankstown", kind: "council",
    population: 389_687, erpYear: 2025, councilHouseMedianPeriod: "", fagYear: "", approvalsThrough: "",
    priceDropShare: 0.07,
  } as CouncilMapRow,
];

// 2026-09-24T01:00Z (as_of) and 2026-09-23T20:00Z (data_through).
const stamps = {
  asOf: { seconds: 1790211600, nanos: 0 },
  dataThrough: { seconds: 1790193600, nanos: 0 },
};

function renderMap(metricKey: "price_drop_share" | "population", dropsStamps?: typeof stamps) {
  return render(
    <CouncilLevelMap
      stateCode="NSW"
      topology={{ type: "Topology", objects: {}, arcs: [] } as unknown as Topology}
      objectName="suburbs"
      lgaBySal={new Map()}
      councils={councils}
      metricKey={metricKey}
      dropsStamps={dropsStamps}
    />,
  );
}

describe("CouncilLevelMap drops legend", () => {
  afterEach(() => jest.useRealTimers());

  it("dates the crawl-derived drops share", () => {
    jest.useFakeTimers({ now: new Date("2026-09-25T00:00:00Z") });
    renderMap("price_drop_share", stamps);
    const note = screen.getByTestId("council-drops-freshness");
    expect(note).toHaveTextContent("Data to 24 Sep 2026.");
    expect(note).not.toHaveTextContent("three days");
    expect(note).not.toHaveAttribute("role");
  });

  it("flags it stale past the /price-drops 72h rule", () => {
    jest.useFakeTimers({ now: new Date("2026-09-28T00:00:00Z") });
    renderMap("price_drop_share", stamps);
    const note = screen.getByTestId("council-drops-freshness");
    expect(note).toHaveAttribute("role", "status");
    expect(note).toHaveTextContent(/Data to 24 Sep 2026\. Not updated for more than three days/);
  });

  it("adds nothing to any other metric's legend, or when the share is undated", () => {
    jest.useFakeTimers({ now: new Date("2026-09-28T00:00:00Z") });
    const { unmount } = renderMap("population", stamps);
    expect(screen.queryByTestId("council-drops-freshness")).toBeNull();
    unmount();
    renderMap("price_drop_share");
    expect(screen.queryByTestId("council-drops-freshness")).toBeNull();
  });
});
