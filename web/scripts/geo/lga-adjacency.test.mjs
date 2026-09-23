// Guards the council adjacency the API embeds (lga_adjacency.json): it must be
// exactly what the committed suburb topology + bridge produce, symmetric, and
// right about councils a reader can check on a map.
//
//   node --test web/scripts/geo/lga-adjacency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { OUTPUT, build, councilAdjacency, serialize } from "./build-lga-adjacency.mjs";

const committed = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));

test("the committed artifact is what the committed inputs produce", () => {
  assert.equal(fs.readFileSync(OUTPUT, "utf8"), serialize(build()), "re-run build-lga-adjacency.mjs");
});

test("adjacency is symmetric and never self-referential", () => {
  for (const [a, list] of Object.entries(committed.neighbours)) {
    assert.ok(!list.includes(a), `${a} lists itself`);
    for (const b of list) assert.ok(committed.neighbours[b]?.includes(a), `${a} -> ${b} is one-way`);
  }
});

test("councils a reader can check on a map", () => {
  const n = committed.neighbours;
  // Canterbury-Bankstown touches Bayside, Georges River and Strathfield...
  for (const code of ["10500", "12930", "17100"]) assert.ok(n["11570"].includes(code), code);
  // ...but not the Northern Beaches, across the harbour.
  assert.ok(!n["11570"].includes("15990"));
  // Yarra (VIC) touches Melbourne; Broken Hill sits inside Unincorporated NSW.
  assert.ok(n["27350"].includes("24600"));
  assert.ok(n["11250"].includes("19399"));
  // The ACT is one council: nothing to neighbour within the territory.
  assert.equal(n["89399"], undefined);
});

test("a shared arc between two councils' suburbs makes them neighbours; an arc inside one council does not", () => {
  // Three suburbs in a row: A|B share arc 0, B|C share arc 1.
  const topo = {
    objects: {
      s: {
        geometries: [
          { type: "Polygon", id: "1", arcs: [[0, 2]] },
          { type: "Polygon", id: "2", arcs: [[~0, 1, 3]] },
          { type: "Polygon", id: "3", arcs: [[~1, 4]] },
        ],
      },
    },
  };
  const bridge = { 1: { lga: "X" }, 2: { lga: "X" }, 3: { lga: "Y" } };
  assert.deepEqual(councilAdjacency(bridge, { T: topo }), { X: ["Y"], Y: ["X"] });
});
