import {
  buildStateSilhouetteModel,
  centeredFitExtent,
  stateFeatureId,
} from "../state-banner-geometry";
import { geoMercator, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { Topology } from "topojson-specification";

jest.mock("d3-geo", () => ({
  geoMercator: jest.fn(),
  geoPath: jest.fn(),
}));

jest.mock("topojson-client", () => ({ feature: jest.fn() }));

describe("stateFeatureId", () => {
  it("maps economy state slugs to numeric ABS STE feature ids", () => {
    expect(
      (["nsw", "vic", "qld", "sa", "wa", "tas", "nt", "act"] as const).map(
        stateFeatureId,
      ),
    ).toEqual(["1", "2", "3", "4", "5", "6", "7", "8"]);
  });
});

describe("centeredFitExtent", () => {
  it("keeps generous padding symmetric around the viewBox centre", () => {
    const extent = centeredFitExtent(360, 260, 52, 38);

    expect(extent).toEqual([
      [52, 38],
      [308, 222],
    ]);
    expect((extent[0][0] + extent[1][0]) / 2).toBe(180);
    expect((extent[0][1] + extent[1][1]) / 2).toBe(130);
  });
});

describe("buildStateSilhouetteModel", () => {
  it("fits only the selected state feature into the centered padded extent", () => {
    const target = {
      type: "Feature",
      id: "8",
      properties: {},
      geometry: { type: "Polygon", coordinates: [] },
    };
    const other = {
      type: "Feature",
      id: "1",
      properties: {},
      geometry: { type: "Polygon", coordinates: [] },
    };
    const fitExtent = jest.fn();
    const projection = Object.assign(jest.fn(), { fitExtent });
    fitExtent.mockReturnValue(projection);
    const path = jest.fn(() => "M52,38L308,222Z");

    jest.mocked(feature).mockReturnValue({
      type: "FeatureCollection",
      features: [other, target],
    } as never);
    jest.mocked(geoMercator).mockReturnValue(projection as never);
    jest.mocked(geoPath).mockReturnValue(path as never);

    const topology = {
      type: "Topology",
      objects: {
        STE_2021_AUST_GDA2020: { type: "GeometryCollection", geometries: [] },
      },
      arcs: [],
    } as unknown as Topology;

    expect(buildStateSilhouetteModel(topology, "act")).toEqual({
      d: "M52,38L308,222Z",
      featureId: "8",
    });
    expect(fitExtent).toHaveBeenCalledWith(
      [
        [52, 38],
        [308, 222],
      ],
      target,
    );
    expect(path).toHaveBeenCalledWith(target);
  });
});
