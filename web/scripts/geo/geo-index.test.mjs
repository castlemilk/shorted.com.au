import { test } from "node:test";
import assert from "node:assert/strict";
import { makePolygonIndex, haversineKm, nearestPoint } from "./geo-index.mjs";

// Two non-overlapping unit squares as GeoJSON-ish features with an `id` (SAL code).
const features = [
  { id: "10001", geometry: { type: "Polygon", coordinates: [[[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]] } },
  { id: "10002", geometry: { type: "Polygon", coordinates: [[[2, 2], [2, 3], [3, 3], [3, 2], [2, 2]]] } },
];

test("locate returns the containing feature id", () => {
  const idx = makePolygonIndex(features);
  assert.equal(idx.locate(0.5, 0.5), "10001");
  assert.equal(idx.locate(2.5, 2.5), "10002");
});

test("locate returns null outside all polygons", () => {
  const idx = makePolygonIndex(features);
  assert.equal(idx.locate(1.5, 1.5), null);
  assert.equal(idx.locate(-1, -1), null);
});

test("locate respects holes", () => {
  const donut = [{
    id: "20001",
    geometry: { type: "Polygon", coordinates: [
      [[0, 0], [0, 10], [10, 10], [10, 0], [0, 0]],   // outer
      [[4, 4], [4, 6], [6, 6], [6, 4], [4, 4]],        // hole
    ] },
  }];
  const idx = makePolygonIndex(donut);
  assert.equal(idx.locate(1, 1), "20001"); // in ring, outside hole
  assert.equal(idx.locate(5, 5), null);    // inside the hole
});

test("centroids exposes a representative interior point per feature", () => {
  const idx = makePolygonIndex(features);
  const c = idx.centroids();
  assert.equal(c.get("10001").length, 2);
  // centroid of the unit square is ~(0.5,0.5) and must locate back to itself
  assert.equal(idx.locate(...c.get("10001")), "10001");
});

test("haversineKm matches a known distance", () => {
  // Sydney CBD → Parramatta is ~21.5km; assert within 2km.
  const d = haversineKm(151.2093, -33.8688, 151.0, -33.815);
  assert.ok(Math.abs(d - 21.5) < 2, `got ${d}`);
});

test("nearestPoint returns the closest point and its distance", () => {
  const pts = [
    { lon: 151.0, lat: -33.8, name: "A" },
    { lon: 152.0, lat: -34.0, name: "B" },
  ];
  const r = nearestPoint(151.05, -33.82, pts);
  assert.equal(r.point.name, "A");
  assert.ok(r.distKm < 10);
});

test("nearestPoint returns null on empty input", () => {
  assert.equal(nearestPoint(151, -33, []), null);
});
