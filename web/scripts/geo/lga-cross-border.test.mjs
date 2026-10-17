// Guards the cross-border council pairs (lga-cross-border.json) merged into the
// API's adjacency artifact: the geometry rule itself, and — when the ABS
// boundaries are staged — that the committed pairs are what they produce.
//
//   node --test web/scripts/geo/lga-cross-border.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { INPUT, OUTPUT, TOLERANCE_M, buildDoc, crossBorderPairs, isPseudoLga, segmentDistanceM, serialize } from "./build-lga-cross-border.mjs";

// A square council, `size` degrees, with its south-west corner at (lon, lat).
const square = (code, name, lon, lat, size = 0.1) => ({
  properties: { lga_code_2024: code, lga_name_2024: name },
  geometry: {
    type: "Polygon",
    coordinates: [[[lon, lat], [lon + size, lat], [lon + size, lat + size], [lon, lat + size], [lon, lat]]],
  },
});
const metresOfLon = (m, lat) => m / (111320 * Math.cos((lat * Math.PI) / 180));
const LAT = -36.1;

test("councils that touch across a state line are neighbours; same-state ones are not listed", () => {
  const fc = {
    features: [
      square("10050", "Albury", 146.8, LAT),
      square("27170", "Wodonga", 146.9, LAT), // shares Albury's east edge
      square("13340", "Greater Hume", 146.8, LAT + 0.1), // same state as Albury: not a cross-border pair
    ],
  };
  const pairs = crossBorderPairs(fc);
  assert.deepEqual(pairs.map((p) => `${p.a}-${p.b}`), ["10050-27170", "13340-27170"]);
  assert.equal(pairs[0].distance_m, 0);
  assert.equal(pairs[0].a_name, "Albury");
});

test("the tolerance: 40 m apart is a neighbour, 80 m is not", () => {
  const near = { features: [square("10050", "A", 146.8, LAT), square("27170", "B", 146.9 + metresOfLon(40, LAT), LAT)] };
  const far = { features: [square("10050", "A", 146.8, LAT), square("27170", "B", 146.9 + metresOfLon(80, LAT), LAT)] };
  assert.equal(TOLERANCE_M, 50);
  const [p] = crossBorderPairs(near);
  assert.ok(p && p.distance_m > 35 && p.distance_m < 45, JSON.stringify(p));
  assert.deepEqual(crossBorderPairs(far), []);
});

test("pseudo areas never border anything, and a missing geometry is skipped", () => {
  for (const code of ["19499", "19799", "89499", "ZZZZZ"]) assert.ok(isPseudoLga(code), code);
  for (const code of ["10050", "19399", "89399", "99399"]) assert.ok(!isPseudoLga(code), code);
  const fc = {
    features: [
      square("10050", "Albury", 146.8, LAT),
      square("29499", "No usual address (Vic.)", 146.9, LAT),
      { properties: { lga_code_2024: "27170", lga_name_2024: "Wodonga" }, geometry: null },
    ],
  };
  assert.deepEqual(crossBorderPairs(fc), []);
});

test("crossing segments are 0 m apart even with no vertex near the other", () => {
  assert.equal(segmentDistanceM([146.8, -36.0, 147.0, -36.2], [146.8, -36.2, 147.0, -36.0]), 0);
  const d = segmentDistanceM([146.8, LAT, 146.8, LAT + 0.1], [146.8 + metresOfLon(30, LAT), LAT, 146.8 + metresOfLon(30, LAT), LAT + 0.1]);
  assert.ok(Math.abs(d - 30) < 0.5, String(d));
});

test("the committed pairs are symmetric-ready, sorted and within tolerance", () => {
  const doc = JSON.parse(fs.readFileSync(OUTPUT, "utf8"));
  assert.equal(doc.tolerance_m, TOLERANCE_M);
  const keys = doc.pairs.map((p) => `${p.a}|${p.b}`);
  assert.deepEqual(keys, [...keys].sort(), "sorted");
  assert.equal(new Set(keys).size, keys.length, "unique");
  for (const p of doc.pairs) {
    assert.ok(p.a < p.b, `${p.a} < ${p.b}`);
    assert.notEqual(p.a[0], p.b[0], `${p.a}-${p.b} is same-state`);
    assert.ok(!isPseudoLga(p.a) && !isPseudoLga(p.b));
    assert.ok(p.distance_m <= TOLERANCE_M);
  }
  assert.ok(keys.includes("10050|27170"), "Albury-Wodonga");
});

test("the committed pairs are what the staged ABS boundaries produce", { skip: !fs.existsSync(INPUT) && "ABS boundaries not staged (node fetch-abs-lga.mjs)" }, () => {
  const fc = JSON.parse(fs.readFileSync(INPUT, "utf8"));
  assert.equal(fs.readFileSync(OUTPUT, "utf8"), serialize(buildDoc(fc)), "re-run build-lga-cross-border.mjs");
});
