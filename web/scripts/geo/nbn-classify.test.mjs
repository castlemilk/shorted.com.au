import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySuburb, techAtPoint, UNKNOWN } from "./nbn-classify.mjs";

const at = (...hits) => ({ locate: (lon, lat) => (hits.some(([x, y]) => x === lon && y === lat) ? "hit" : null) });

test("a point outside every footprint is unknown, not Satellite", () => {
  const idx = { fixedLine: at([1, 1]), fixedWireless: at([2, 2]), satellite: null };
  assert.equal(techAtPoint(9, 9, idx), UNKNOWN);
});

test("only a staged satellite footprint can yield Satellite", () => {
  assert.equal(techAtPoint(3, 3, { fixedLine: at(), fixedWireless: at(), satellite: at([3, 3]) }), "Satellite");
  assert.equal(techAtPoint(3, 3, { fixedLine: at(), fixedWireless: at(), satellite: null }), UNKNOWN);
});

test("fixed line outranks fixed wireless where both footprints cover a point", () => {
  assert.equal(techAtPoint(1, 1, { fixedLine: at([1, 1]), fixedWireless: at([1, 1]), satellite: at([1, 1]) }), "Fixed Line");
  assert.equal(techAtPoint(2, 2, { fixedLine: at(), fixedWireless: at([2, 2]), satellite: at([2, 2]) }), "Fixed Wireless");
});

test("a suburb no footprint touched has no technology (NULL), never Satellite", () => {
  assert.deepEqual(classifySuburb({ [UNKNOWN]: 16 }), { tech: null, score: null });
  assert.deepEqual(classifySuburb({}), { tech: null, score: null });
});

test("unknown points abstain: a partly covered suburb takes its covered majority", () => {
  // Bondi's real shape: a patchy fixed-line layer covers a few sample points.
  assert.deepEqual(classifySuburb({ "Fixed Line": 3, [UNKNOWN]: 13 }), { tech: "Fixed Line", score: 90 });
  assert.deepEqual(classifySuburb({ "Fixed Line": 2, "Fixed Wireless": 5, [UNKNOWN]: 9 }), { tech: "Fixed Wireless", score: 55 });
});

test("ties break toward the better tier", () => {
  assert.equal(classifySuburb({ "Fixed Line": 4, "Fixed Wireless": 4 }).tech, "Fixed Line");
  assert.equal(classifySuburb({ "Fixed Wireless": 2, Satellite: 2 }).tech, "Fixed Wireless");
});
