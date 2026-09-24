import { render, screen } from "@testing-library/react";

import { CouncilIndexMap, COUNCIL_INDEX_MAP_HEIGHT } from "./council-index-map";

jest.mock("../use-topojson", () => ({
  useTopojson: () => ({ data: { type: "Topology", objects: { suburbs: {} }, arcs: [] }, isError: false }),
}));
jest.mock("../use-suburb-columns", () => ({
  useSuburbColumns: () => ({ isLoading: false, data: new Map([["lga_code", {}]]) }),
}));
jest.mock("@/lib/housing/council-geometry", () => ({
  lgaCodesFromColumn: () => new Map([["10001", "11570"]]),
}));
jest.mock("../council-level-map", () => ({
  CouncilLevelMap: () => <div data-testid="council-level-map" />,
}));
jest.mock("../housing-icon", () => ({ HousingIcon: () => null }));
jest.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return { Select: Pass, SelectContent: Pass, SelectItem: Pass, SelectTrigger: Pass, SelectValue: () => null };
});

describe("CouncilIndexMap frame", () => {
  // ChoroplethMap fills its parent through ParentSize (height: 100%). A
  // percentage of a box that has only a min-height resolves to 0, so the map
  // measured 1120x0 and never drew. The frame must carry a definite height.
  it("gives the map a definite height, not just a minimum", () => {
    render(<CouncilIndexMap stateCode="NSW" councils={[]} />);
    const frame = screen.getByTestId("council-index-map-frame");
    expect(COUNCIL_INDEX_MAP_HEIGHT).toMatch(/^h-\[\d+px\]$/);
    expect(frame.className.split(/\s+/)).toContain(COUNCIL_INDEX_MAP_HEIGHT);
    expect(screen.getByTestId("council-level-map")).toBeInTheDocument();
  });
});
