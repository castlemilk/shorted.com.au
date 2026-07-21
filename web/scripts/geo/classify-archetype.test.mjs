import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyArchetype, ARCHETYPE_BASE } from "./classify-archetype.mjs";

test("coastal suburb (close to coast, not CBD) → coastal-beach", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 0.4, amenityDensityScore: 40, parksCount: 3, population: 12000 }), "coastal-beach");
});
test("very dense inner-city → urban-skyline", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 1.2, amenityDensityScore: 92, parksCount: 2, population: 20000 }), "urban-skyline");
});
test("dense inner suburb (55–80) → inner-terraces", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 8, amenityDensityScore: 66, parksCount: 4, population: 9000 }), "inner-terraces");
});
test("high parks, mid density → parkland", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 15, amenityDensityScore: 45, parksCount: 40, population: 8000 }), "parkland");
});
test("mid-density suburban default → leafy-suburban", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 20, amenityDensityScore: 38, parksCount: 5, population: 7000 }), "leafy-suburban");
});
test("remote low-amenity inland → bushland", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 120, amenityDensityScore: 8, parksCount: 1, population: 400 }), "bushland");
});
test("missing signals → leafy-suburban (safe default)", () => {
  assert.equal(classifyArchetype({}), "leafy-suburban");
});
test("ARCHETYPE_BASE excludes LLM-only archetypes", () => {
  assert.ok(!ARCHETYPE_BASE.includes("harbour") && !ARCHETYPE_BASE.includes("hills-ranges"));
});
test("dense-but-coastal stays urban (coastal rule gated by dens < 80)", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 1.9, amenityDensityScore: 85 }), "urban-skyline");
});
test("coast rule is strict < 2 (exactly 2km is not coastal-beach)", () => {
  assert.equal(classifyArchetype({ distToCoastKm: 2, amenityDensityScore: 40 }), "leafy-suburban");
});
test("null input → leafy-suburban (safe default)", () => {
  assert.equal(classifyArchetype(null), "leafy-suburban");
});
test("dens === 55 lower boundary → inner-terraces", () => {
  assert.equal(classifyArchetype({ amenityDensityScore: 55 }), "inner-terraces");
});
