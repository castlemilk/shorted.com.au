import { fireEvent, render, screen } from "@testing-library/react";
import type { Topology } from "topojson-specification";

import type { ChoroplethMapProps } from "../choropleth-map";
import type { StatePriceDropSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import { StateDropsMap } from "./state-drops-map";

const push = jest.fn();
let searchParams = new URLSearchParams("state=vic&view=map");
let topoResult: { data?: Topology; isLoading?: boolean; isError?: boolean } =
  {};
let mapProps: ChoroplethMapProps | undefined;

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => searchParams,
}));

jest.mock("../use-topojson", () => ({
  useTopojson: () => topoResult,
}));

jest.mock("../choropleth-map", () => ({
  ChoroplethMap: (props: ChoroplethMapProps) => {
    mapProps = props;
    return (
      <div>
        <button type="button" onClick={() => props.onFeatureClick?.("1")}>
          Select New South Wales
        </button>
        {props.legend}
      </div>
    );
  },
}));

const topology = {
  type: "Topology",
  objects: {
    STE_2021_AUST_GDA2020: { type: "GeometryCollection", geometries: [] },
  },
  arcs: [],
} as unknown as Topology;

function state(stateCode: string, droppedShare: number): StatePriceDropSummary {
  return { stateCode, droppedShare } as StatePriceDropSummary;
}

describe("StateDropsMap", () => {
  beforeEach(() => {
    push.mockClear();
    searchParams = new URLSearchParams("state=vic&view=map");
    topoResult = { data: topology, isLoading: false, isError: false };
    mapProps = undefined;
  });

  it("maps state drop shares to real topology ids in percentage units", () => {
    render(
      <StateDropsMap
        states={[state("NSW", 0.042), state("VIC", 0.031), state("AU", 0.038)]}
      />,
    );

    expect(mapProps?.valueById.get("1")).toBeCloseTo(4.2);
    expect(mapProps?.valueById.get("2")).toBeCloseTo(3.1);
    expect(mapProps?.valueById.has("AU")).toBe(false);
    expect(mapProps?.selectedId).toBe("2");
    expect(mapProps?.nameById?.get("1")).toBe(
      "New South Wales — 4.2% of tracked listings cut in 30 days",
    );
    expect(screen.getByText("Listings cut (30d)")).toBeInTheDocument();
    expect(screen.getByText("Not tracked")).toBeInTheDocument();
  });

  it("sets the existing state deep link without dropping other query parameters", () => {
    render(<StateDropsMap states={[state("NSW", 0.042)]} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Select New South Wales" }),
    );

    expect(push).toHaveBeenCalledWith("/price-drops?state=nsw&view=map", {
      scroll: false,
    });
  });

  it("falls back to the accessible state table when boundaries cannot load", () => {
    topoResult = { data: undefined, isLoading: false, isError: true };

    render(<StateDropsMap states={[state("NSW", 0.042)]} />);

    expect(
      screen.getByText("Map unavailable — compare states in the table below."),
    ).toBeInTheDocument();
  });
});
