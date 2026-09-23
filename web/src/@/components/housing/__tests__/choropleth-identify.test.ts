import type { Feature, Geometry, Polygon } from "geojson";
import { identifyAt, type IdentifyPart } from "../choropleth-map";

// d3-geo is mocked under Jest (ESM), so containment is injected: a planar
// ray-cast is exact for these small axis-aligned squares. What is under test
// is the bbox pruning, the per-class de-duplication and the hit shape.
const square = (x0: number, y0: number, x1: number, y1: number): Feature<Geometry> => ({
  type: "Feature", properties: null,
  geometry: { type: "Polygon", coordinates: [[[x0, y0], [x0, y1], [x1, y1], [x1, y0], [x0, y0]]] },
});

function planarContains(f: Feature<Geometry>, [x, y]: [number, number]): boolean {
  const ring = (f.geometry as Polygon).coordinates[0]!;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if ((yi! > y) !== (yj! > y) && x < ((xj! - xi!) * (y - yi!)) / (yj! - yi!) + xi!) inside = !inside;
  }
  return inside;
}

const part = (value: string, label: string, [x0, y0, x1, y1]: number[]): IdentifyPart => ({
  key: "zoning", value, label, color: "#000", polygon: square(x0!, y0!, x1!, y1!),
  bounds: [[x0!, y0!], [x1!, y1!]],
});

describe("categorical overlay hover identify", () => {
  const parts = [
    part("res_low", "Low-density residential", [151.0, -33.9, 151.1, -33.8]),
    part("res_low", "Low-density residential", [151.05, -33.85, 151.15, -33.75]), // overlaps, same class
    part("industrial", "Industrial & employment", [151.2, -33.9, 151.3, -33.8]),
  ];

  test("names the class whose polygon contains the pointer", () => {
    expect(identifyAt(parts, [151.25, -33.85], planarContains).map((h) => h.value)).toEqual(["industrial"]);
  });

  test("reports a class once even when two of its parts contain the pointer", () => {
    const hits = identifyAt(parts, [151.07, -33.82], planarContains);
    expect(hits).toEqual([{ key: "zoning", value: "res_low", label: "Low-density residential", color: "#000" }]);
  });

  test("outside every polygon there is no hit, and bbox pruning skips the containment test", () => {
    const contains = jest.fn(planarContains);
    expect(identifyAt(parts, [151.17, -33.85], contains)).toEqual([]);
    expect(identifyAt(parts, [140, -30], contains)).toEqual([]);
    expect(contains).not.toHaveBeenCalled();
  });
});
