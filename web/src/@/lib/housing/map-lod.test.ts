import { describe, it, expect } from "@jest/globals";
import {
  detailLevelForScale,
  rectsIntersect,
  viewportInProjected,
  projectedCenter,
  cullFeatures,
  focusedStateFor,
  boundsArea,
  SUBURB_SWITCH_SCALE,
  type BoundedFeature,
  type Bounds,
} from "./map-lod";

describe("detailLevelForScale", () => {
  it("stays national below the switch scale", () => {
    expect(detailLevelForScale(1)).toBe("national");
    expect(detailLevelForScale(SUBURB_SWITCH_SCALE - 0.01)).toBe("national");
  });
  it("switches to suburb at/above the switch scale", () => {
    expect(detailLevelForScale(SUBURB_SWITCH_SCALE)).toBe("suburb");
    expect(detailLevelForScale(40)).toBe("suburb");
  });
  it("honours a custom threshold", () => {
    expect(detailLevelForScale(5, 10)).toBe("national");
    expect(detailLevelForScale(12, 10)).toBe("suburb");
  });
});

describe("rectsIntersect", () => {
  const a = { minX: 0, minY: 0, maxX: 10, maxY: 10 };
  it("is true for overlap and edge-touch", () => {
    expect(rectsIntersect(a, { minX: 5, minY: 5, maxX: 15, maxY: 15 })).toBe(true);
    expect(rectsIntersect(a, { minX: 10, minY: 0, maxX: 20, maxY: 10 })).toBe(true); // touch
  });
  it("is false when disjoint", () => {
    expect(rectsIntersect(a, { minX: 11, minY: 0, maxX: 20, maxY: 10 })).toBe(false);
    expect(rectsIntersect(a, { minX: 0, minY: 11, maxX: 10, maxY: 20 })).toBe(false);
  });
});

describe("viewportInProjected / projectedCenter", () => {
  it("returns the whole screen in projected coords for the identity transform (no margin)", () => {
    expect(viewportInProjected(1, 0, 0, 100, 80, 0)).toEqual({
      minX: 0,
      minY: 0,
      maxX: 100,
      maxY: 80,
    });
  });
  it("shrinks the projected viewport as scale grows (zoomed in shows less)", () => {
    // k=2 centred: transform x/y = -50,-40 keeps the projected centre at (50,40).
    const vp = viewportInProjected(2, -50, -40, 100, 80, 0);
    expect(vp).toEqual({ minX: 25, minY: 20, maxX: 75, maxY: 60 });
    expect(projectedCenter(2, -50, -40, 100, 80)).toEqual([50, 40]);
  });
  it("expands by the margin fraction on each edge", () => {
    const vp = viewportInProjected(1, 0, 0, 100, 100, 0.1);
    expect(vp).toEqual({ minX: -10, minY: -10, maxX: 110, maxY: 110 });
  });
});

describe("cullFeatures", () => {
  const mk = (id: string, b: Bounds): BoundedFeature<string> => ({
    id,
    feature: id,
    bounds: b,
    area: boundsArea(b),
  });
  const feats = [
    mk("in", [[10, 10], [20, 20]]),
    mk("out", [[200, 200], [210, 210]]),
    mk("edge", [[0, 0], [5, 5]]),
  ];
  const vp = { minX: 0, minY: 0, maxX: 50, maxY: 50 };

  it("keeps only features intersecting the viewport", () => {
    const ids = cullFeatures(feats, vp).map((f) => f.id).sort();
    expect(ids).toEqual(["edge", "in"]);
  });
  it("caps to the largest-area features when over the cap", () => {
    const many: BoundedFeature<string>[] = [
      mk("big", [[0, 0], [40, 40]]),
      mk("mid", [[0, 0], [20, 20]]),
      mk("small", [[0, 0], [5, 5]]),
    ];
    const kept = cullFeatures(many, vp, 2).map((f) => f.id);
    expect(kept).toEqual(["big", "mid"]);
    expect(kept).not.toContain("small");
  });
  it("returns [] when nothing is visible", () => {
    expect(cullFeatures([mk("out", [[200, 200], [210, 210]])], vp)).toEqual([]);
  });
});

describe("focusedStateFor", () => {
  // NSW bbox wholly contains ACT's bbox (as in the real projection).
  const states = [
    { id: "NSW", bounds: [[0, 0], [100, 100]] as Bounds },
    { id: "ACT", bounds: [[40, 40], [50, 50]] as Bounds },
    { id: "VIC", bounds: [[0, 100], [100, 160]] as Bounds },
  ];
  it("picks the smallest containing bbox (ACT nested inside NSW)", () => {
    expect(focusedStateFor([45, 45], states)).toBe("ACT");
  });
  it("picks the sole containing state", () => {
    expect(focusedStateFor([10, 10], states)).toBe("NSW");
    expect(focusedStateFor([10, 130], states)).toBe("VIC");
  });
  it("falls back to the nearest state centre when outside every bbox", () => {
    // (200, 130) is right of everything; VIC's centre (50,130) is nearest.
    expect(focusedStateFor([200, 130], states)).toBe("VIC");
  });
});
