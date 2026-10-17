// The shared jest mock stubs topojson-client (ESM); these tests need the real
// arc maths, so they load the package's UMD build.
jest.mock("topojson-client", () => jest.requireActual("topojson-client/dist/topojson-client.js"));

import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

import { councilBorders, councilTopology, lgaCodesFromColumn, unionOf } from "./council-geometry";

// Three unit squares in a row, sharing arcs: suburb 1 | suburb 2 | suburb 3.
//   arc 0: x=1 edge (1|2), arc 1: x=2 edge (2|3); arcs 2-4 are the outer rings.
const topo: Topology = {
  type: "Topology",
  arcs: [
    [[1, 0], [1, 1]],
    [[2, 0], [2, 1]],
    [[1, 1], [0, 1], [0, 0], [1, 0]],
    [[1, 0], [2, 0]],
    [[2, 1], [1, 1]],
    [[2, 0], [3, 0], [3, 1], [2, 1]],
  ],
  objects: {
    sal: {
      type: "GeometryCollection",
      geometries: [
        { type: "Polygon", id: "1", arcs: [[0, 2]] },
        { type: "Polygon", id: "2", arcs: [[~0, 3, 1, 4]] },
        { type: "Polygon", id: "3", arcs: [[~1, 5]] },
      ],
    } as GeometryCollection,
  },
};

describe("council geometry from suburb topology", () => {
  test("lga_code column values become ABS code strings; missing stays null", () => {
    const codes = lgaCodesFromColumn(new Map([["1", 11570], ["2", 11570.0000001], ["3", null]]));
    expect([...codes]).toEqual([["1", "11570"], ["2", "11570"], ["3", null]]);
    expect(lgaCodesFromColumn(undefined).size).toBe(0);
  });

  test("borders are only the lines between two different, known councils", () => {
    const twoCouncils = new Map([["1", "A"], ["2", "A"], ["3", "B"]]);
    const lines = councilBorders(topo, "sal", twoCouncils);
    expect(lines?.coordinates).toEqual([[[2, 0], [2, 1]]]);
    // One council: nothing internal to draw.
    expect(councilBorders(topo, "sal", new Map([["1", "A"], ["2", "A"], ["3", "A"]]))).toBeNull();
    // An unknown neighbour is not a council border.
    expect(councilBorders(topo, "sal", new Map([["1", "A"], ["2", "A"], ["3", null]]))).toBeNull();
  });

  test("councilTopology merges each council's suburbs into one feature keyed by code", () => {
    const { topology, objectName, councils } = councilTopology(topo, "sal", new Map([["1", "A"], ["2", "A"], ["3", "B"]]));
    expect(councils).toBe(2);
    const fc = feature(topology, topology.objects[objectName] as GeometryCollection) as unknown as {
      features: Array<{ id: string; geometry: { type: string; coordinates: number[][][][] } }>;
    };
    const byId = Object.fromEntries(fc.features.map((f) => [f.id, f.geometry]));
    expect(Object.keys(byId).sort()).toEqual(["A", "B"]);
    // A is one polygon (the shared arc between 1 and 2 dissolved): a single ring.
    expect(byId.A!.type).toBe("MultiPolygon");
    expect(byId.A!.coordinates).toHaveLength(1);
    const xs = byId.A!.coordinates[0]![0]!.map(([x]) => x);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(2);
  });

  test("suburbs with no council are left out of the council layer", () => {
    const { councils } = councilTopology(topo, "sal", new Map([["1", "A"], ["2", null]]));
    expect(councils).toBe(1);
  });

  test("unionOf outlines a set of suburbs, or nothing", () => {
    const u = unionOf(topo, "sal", new Set(["2", "3"]));
    expect(u?.coordinates).toHaveLength(1);
    expect(unionOf(topo, "sal", new Set(["nope"]))).toBeNull();
  });
});
