// Guards the council adjacency the API embeds (lga_adjacency.json): it must be
// exactly what the committed suburb topology + bridge produce, symmetric, and
// right about councils a reader can check on a map.
//
//   node --test web/scripts/geo/lga-adjacency.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { OUTPUT, build, councilAdjacency, crossStateAdjacency, serialize } from "./build-lga-adjacency.mjs";
import { stateOfLga } from "./build-lga-cross-border.mjs";

const committed = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));

test("the committed artifact is what the committed inputs produce", () => {
  assert.equal(fs.readFileSync(OUTPUT, "utf8"), serialize(build()), "re-run build-lga-adjacency.mjs");
});

test("adjacency is symmetric and never self-referential", () => {
  for (const map of [committed.neighbours, committed.cross_state]) {
    for (const [a, list] of Object.entries(map)) {
      assert.ok(!list.includes(a), `${a} lists itself`);
      for (const b of list) assert.ok(map[b]?.includes(a), `${a} -> ${b} is one-way`);
    }
  }
});

test("cross_state holds only pairs across a state line, and neighbours only pairs within one", () => {
  for (const [a, list] of Object.entries(committed.cross_state)) {
    for (const b of list) assert.notEqual(stateOfLga(a), stateOfLga(b), `${a} -> ${b} is same-state`);
  }
  for (const [a, list] of Object.entries(committed.neighbours)) {
    for (const b of list) assert.equal(stateOfLga(a), stateOfLga(b), `${a} -> ${b} crosses a border`);
  }
});

test("councils that meet across a state or territory border", () => {
  const x = committed.cross_state;
  // Albury (NSW) and Wodonga (VIC) face each other across the Murray.
  assert.ok(x["10050"].includes("27170"), "Albury -> Wodonga");
  assert.ok(x["27170"].includes("10050"), "Wodonga -> Albury");
  // Queanbeyan-Palerang and Yass Valley wrap the ACT; Tweed meets the Gold Coast.
  assert.ok(x["89399"].includes("16490") && x["89399"].includes("18710"));
  assert.ok(x["17550"].includes("33430"), "Tweed -> Gold Coast");
  // Murray River Council (NSW) faces Campaspe, Gannawarra, Moira and Swan Hill.
  for (const vic of ["21370", "22250", "24900", "26610"]) assert.ok(x["15520"].includes(vic), vic);
  // Not a border council: Canterbury-Bankstown has no cross-state neighbour.
  assert.equal(x["11570"], undefined);
  // Albury's same-state neighbours are untouched.
  assert.deepEqual(committed.neighbours["10050"], ["13340"]);
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
  // The ACT is one council: nothing to neighbour WITHIN the territory (its
  // neighbours are all across the border, in cross_state).
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

test("cross-border pairs are symmetrised", () => {
  assert.deepEqual(crossStateAdjacency([{ a: "10050", b: "27170" }, { a: "10050", b: "26670" }]), {
    10050: ["26670", "27170"],
    26670: ["10050"],
    27170: ["10050"],
  });
});
