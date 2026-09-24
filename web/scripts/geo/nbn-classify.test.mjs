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

test("every tier requires coverage on at least half of all sampled points", () => {
  // Bondi's patchy fixed-line footprint is not enough to assert a suburb tier.
  assert.deepEqual(classifySuburb({ "Fixed Line": 3, [UNKNOWN]: 13 }), { tech: null, score: null });
  assert.deepEqual(classifySuburb({ "Fixed Line": 1, [UNKNOWN]: 11 }), { tech: null, score: null });
  assert.deepEqual(classifySuburb({ "Fixed Line": 4, [UNKNOWN]: 5 }), { tech: null, score: null });
  assert.deepEqual(classifySuburb({ "Fixed Line": 5, [UNKNOWN]: 5 }), { tech: "Fixed Line", score: 90 });
});

test("fixed line needs a strict majority of covered points, with adequate total coverage", () => {
  assert.deepEqual(classifySuburb({ "Fixed Line": 3, "Fixed Wireless": 2, [UNKNOWN]: 5 }), { tech: "Fixed Line", score: 90 });
  assert.deepEqual(classifySuburb({ "Fixed Line": 3, "Fixed Wireless": 2, [UNKNOWN]: 6 }), { tech: null, score: null });
  // A plurality is insufficient even when every sample has coverage.
  assert.deepEqual(classifySuburb({ "Fixed Line": 4, "Fixed Wireless": 3, Satellite: 2 }), { tech: null, score: null });
});

test("fixed wireless needs half of ALL sample points, misses included", () => {
  // Rouse Hill (11,349 people): one coarse tower cell over one point of 12.
  assert.deepEqual(classifySuburb({ "Fixed Wireless": 1, [UNKNOWN]: 11 }), { tech: null, score: null });
  // Jordan Springs 0/3/13, Muswellbrook 0/4/6: a covered plurality is not enough.
  assert.equal(classifySuburb({ "Fixed Wireless": 3, [UNKNOWN]: 13 }).tech, null);
  assert.equal(classifySuburb({ "Fixed Wireless": 4, [UNKNOWN]: 6 }).tech, null);
  // Genuinely wireless country: every point, or at least half of them.
  assert.deepEqual(classifySuburb({ "Fixed Wireless": 14 }), { tech: "Fixed Wireless", score: 55 });
  assert.equal(classifySuburb({ "Fixed Wireless": 6, [UNKNOWN]: 6 }).tech, "Fixed Wireless");
});

test("fixed line out-voted by a coarse tier is ambiguous, not wireless", () => {
  // Pimpama 2/4/6, Wallan 3/6/7, Dubbo 1/7/3: fixed line is present, so the
  // wireless grid over the rest is not evidence the premises are wireless.
  assert.deepEqual(classifySuburb({ "Fixed Line": 2, "Fixed Wireless": 4, [UNKNOWN]: 6 }), { tech: null, score: null });
  assert.equal(classifySuburb({ "Fixed Line": 1, "Fixed Wireless": 7, [UNKNOWN]: 3 }).tech, null);
  assert.equal(classifySuburb({ "Fixed Line": 2, "Fixed Wireless": 5, [UNKNOWN]: 9 }).tech, null);
});

test("ties have no strict majority and publish neither a tier nor a quality score", () => {
  assert.deepEqual(classifySuburb({ "Fixed Line": 4, "Fixed Wireless": 4 }), { tech: null, score: null });
  assert.deepEqual(classifySuburb({ "Fixed Wireless": 2, Satellite: 2 }), { tech: null, score: null });
  assert.deepEqual(classifySuburb({ "Fixed Line": 2, "Fixed Wireless": 2, Satellite: 2 }), { tech: null, score: null });
});

test("coarse tiers require half of all samples even if most covered points agree", () => {
  assert.deepEqual(classifySuburb({ "Fixed Wireless": 3, Satellite: 2, [UNKNOWN]: 5 }), { tech: null, score: null });
  assert.deepEqual(classifySuburb({ "Fixed Wireless": 5, Satellite: 2, [UNKNOWN]: 3 }), { tech: "Fixed Wireless", score: 55 });
});

test("satellite, like fixed wireless, needs half of all points", () => {
  assert.equal(classifySuburb({ Satellite: 1, [UNKNOWN]: 9 }).tech, null);
  assert.equal(classifySuburb({ Satellite: 5, [UNKNOWN]: 5 }).tech, "Satellite");
});
