import { geoMercator } from "d3-geo";

import {
  MAX_NEIGHBOURS,
  buildStateLocatorModel,
  buildSuburbLocatorModel,
  compactPath,
  featureBounds,
  featureCentroid,
  findSuburbFeature,
  type SuburbFeature,
} from "./suburb-geometry";

// d3-geo is stubbed in this environment (moduleNameMapper): projections are
// identity and geoPath walks rings straight into whatever context it is given.
// These tests therefore pin the selection logic, the plain-arithmetic geometry
// and the compact serialiser, not d3's rasterisation.

function square(id: string, x: number, y: number, size = 1): SuburbFeature {
  return {
    type: "Feature",
    id,
    properties: {},
    geometry: {
      type: "Polygon",
      coordinates: [[[x, y], [x + size, y], [x + size, y + size], [x, y + size], [x, y]]],
    },
  };
}

describe("featureBounds / featureCentroid", () => {
  it("computes the bbox and area-weighted centroid of a polygon", () => {
    const f = square("1", 150, -33, 2);
    expect(featureBounds(f)).toEqual([[150, -33], [152, -31]]);
    const c = featureCentroid(f);
    expect(c?.lon).toBeCloseTo(151, 6);
    expect(c?.lat).toBeCloseTo(-32, 6);
  });

  it("subtracts holes from the centroid weighting", () => {
    const withHole: SuburbFeature = {
      type: "Feature",
      id: "h",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [
          [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
          // hole in the top-right quadrant, wound the other way
          [[2, 2], [2, 4], [4, 4], [4, 2], [2, 2]],
        ],
      },
    };
    const c = featureCentroid(withHole);
    // Removing the top-right quadrant pulls the centroid down and left.
    expect(c!.lon).toBeLessThan(2);
    expect(c!.lat).toBeLessThan(2);
  });

  it("handles MultiPolygon and degenerate geometry", () => {
    const multi: SuburbFeature = {
      type: "Feature",
      id: "m",
      properties: {},
      geometry: {
        type: "MultiPolygon",
        coordinates: [
          [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
          [[[10, 10], [11, 10], [11, 11], [10, 11], [10, 10]]],
        ],
      },
    };
    expect(featureBounds(multi)).toEqual([[0, 0], [11, 11]]);
    const degenerate: SuburbFeature = {
      type: "Feature",
      id: "d",
      properties: {},
      geometry: { type: "Polygon", coordinates: [[[5, 5], [5, 5], [5, 5]]] },
    };
    expect(featureCentroid(degenerate)).toEqual({ lon: 5, lat: 5 });
  });
});

describe("buildSuburbLocatorModel", () => {
  it("returns null for an unknown SAL code", () => {
    expect(buildSuburbLocatorModel([square("1", 0, 0)], "999")).toBeNull();
  });

  it("finds the target by feature id and keeps only in-view neighbours", () => {
    const features = [
      square("100", 0, 0),
      square("101", 1.5, 0), // adjacent
      square("102", 0, 1.5), // adjacent
      square("103", 50, 50), // far away — outside the padded bbox
    ];
    const model = buildSuburbLocatorModel(features, "100");
    expect(model).not.toBeNull();
    expect(model!.locator.size).toBe(200);
    expect(model!.locator.targetPath).toBe("M0,0L1,0L1,1L0,1Z");
    expect(model!.locator.neighbourPaths.map((n) => n.id).sort()).toEqual(["101", "102"]);
    expect(model!.centroid.lon).toBeCloseTo(0.5, 9);
    expect(model!.centroid.lat).toBeCloseTo(0.5, 9);
    expect(model!.bounds).toEqual([[0, 0], [1, 1]]);
    expect(findSuburbFeature(features, "103")?.id).toBe("103");
  });

  it("skips placeholder features that have no geometry instead of throwing", () => {
    const features: SuburbFeature[] = [
      square("100", 0, 0),
      { type: "Feature", id: "29999", properties: { SAL_NAME21: "No usual address (Vic.)" }, geometry: null },
      square("101", 1.5, 0),
    ];
    const model = buildSuburbLocatorModel(features, "100");
    expect(model!.locator.neighbourPaths.map((n) => n.id)).toEqual(["101"]);
    expect(featureBounds(features[1]!)).toBeNull();
    expect(featureCentroid(features[1]!)).toBeNull();
    // A null-geometry TARGET is simply "no map".
    expect(buildSuburbLocatorModel(features, "29999")).toBeNull();
  });

  it("caps neighbours at MAX_NEIGHBOURS, nearest first", () => {
    // Target centred on (0.05, 0.05); neighbours march away to the east so n1
    // is nearest and n60 farthest, all inside the padded bbox (x <= 0.4).
    const features: SuburbFeature[] = [square("t", 0, 0, 0.1)];
    for (let i = 1; i <= 60; i++) features.push(square(`n${i}`, 0.12 + i * 0.002, 0.05, 0.0005));
    const model = buildSuburbLocatorModel(features, "t");
    expect(model!.locator.neighbourPaths).toHaveLength(MAX_NEIGHBOURS);
    // The nearest neighbour (n1) is kept; the farthest (n60) is dropped.
    const ids = model!.locator.neighbourPaths.map((n) => n.id);
    expect(ids).toContain("n1");
    expect(ids).not.toContain("n60");
  });
});

describe("buildStateLocatorModel", () => {
  it("projects the suburb centroid as a marker inside the state frame", () => {
    const state = square("1", 140, -40, 10);
    const suburb = square("s", 145, -35, 0.2);
    const model = buildStateLocatorModel(state, suburb, { width: 320, height: 200 });
    expect(model).toMatchObject({
      width: 320,
      height: 200,
      // whole pixels for the state outline, one decimal for the suburb
      statePath: "M140,-40L150,-40L150,-30L140,-30Z",
      suburbPath: "M145,-35L145.2,-35L145.2,-34.8L145,-34.8Z",
    });
    // identity projection in the stub: the marker is the raw centroid
    expect(model!.marker.x).toBeCloseTo(145.1, 6);
    expect(model!.marker.y).toBeCloseTo(-34.9, 6);
  });
});

describe("compactPath", () => {
  it("rounds to the requested precision and drops consecutive duplicate points", () => {
    const jagged: SuburbFeature = {
      type: "Feature",
      id: "j",
      properties: {},
      geometry: {
        type: "Polygon",
        coordinates: [[[0, 0], [0.04, 0.02], [0.3, 0.1], [0.31, 0.12], [1, 1], [0, 1], [0, 0]]],
      },
    };
    // At whole-pixel precision the second, third and fourth points all round
    // onto the first and vanish; the closing point is left to Z.
    expect(compactPath(geoMercator(), jagged, 0)).toBe("M0,0L1,1L0,1Z");
    expect(compactPath(geoMercator(), jagged, 1)).toBe("M0,0L0.3,0.1L1,1L0,1Z");
  });

  it("returns an empty string for a feature with no rings", () => {
    const empty: SuburbFeature = { type: "Feature", id: "e", properties: {}, geometry: null };
    expect(compactPath(geoMercator(), empty, 1)).toBe("");
  });
});
