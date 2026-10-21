import {
  SCENE_BOXES,
  SCENE_STILL_TIME,
  hasScene,
  sceneFrame,
  sceneStill,
} from "../scenes";
import { STRATEGY_SLUGS } from "../registry";

const PATH_DATA = /^[MLHVACZSQTmlhvaczsqt0-9 .,-]+$/;

describe("strategy scenes", () => {
  it("draws every registry strategy, and nothing else", () => {
    for (const slug of STRATEGY_SLUGS) expect(hasScene(slug)).toBe(true);
    expect(hasScene("not-a-strategy")).toBe(false);
    expect(hasScene("toString")).toBe(false);
    expect(sceneFrame("not-a-strategy", 360, 120, 1).paths).toEqual([]);
    expect(Object.keys(SCENE_STILL_TIME).sort()).toEqual([...STRATEGY_SLUGS].sort());
  });

  it("is deterministic, finite, and stays near its box at every time", () => {
    for (const slug of STRATEGY_SLUGS) {
      for (const variant of ["band", "plate"] as const) {
        const box = SCENE_BOXES[variant];
        for (const t of [0, 1.7, 4.2, 5.5, 6.9, 13.1, 100]) {
          const a = sceneFrame(slug, box.width, box.height, t);
          const b = sceneFrame(slug, box.width, box.height, t);
          expect(a).toEqual(b);
          expect(a.width).toBe(box.width);
          expect(a.height).toBe(box.height);
          expect(a.paths.length).toBeGreaterThan(4);
          for (const p of a.paths) {
            expect(p.d).toMatch(PATH_DATA);
            expect(p.opacity).toBeGreaterThan(0);
            expect(p.opacity).toBeLessThanOrEqual(1);
            expect(Number.isFinite(p.width)).toBe(true);
            const numbers = (p.d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
            for (const value of numbers) {
              expect(Number.isFinite(value)).toBe(true);
              // Coordinates and arc radii stay within a margin of the box;
              // a path that wanders far off is a bug, not a flourish.
              expect(value).toBeGreaterThanOrEqual(-0.3 * box.width);
              expect(value).toBeLessThanOrEqual(1.3 * box.width);
            }
          }
        }
      }
    }
  });

  it("moves: every scene is a different drawing a second later", () => {
    for (const slug of STRATEGY_SLUGS) {
      const a = sceneFrame(slug, 360, 120, 1).paths.map((p) => p.d).join("|");
      const b = sceneFrame(slug, 360, 120, 2.3).paths.map((p) => p.d).join("|");
      expect(a).not.toBe(b);
    }
  });

  it("uses the theme's tones only, with amber for the strategy's moment", () => {
    const tones = new Set(["ink", "amber", "olive", "rust", "muted"]);
    for (const slug of STRATEGY_SLUGS) {
      const still = sceneStill(slug, "band");
      const used = new Set(still.paths.map((p) => p.tone));
      for (const tone of used) expect(tones.has(tone)).toBe(true);
      expect(used.has("amber")).toBe(true);
    }
  });

  it("takes the still at the strategy's moment", () => {
    // Zanger's plume is over the pivot (y = 0.4h = 48) at the still, and
    // inside the base at the start of the cycle.
    const plumeTop = (t: number) => {
      const frame = sceneFrame("zanger-breakout", 360, 120, t);
      const plume = frame.paths.find((p) => p.tone === "amber" && !p.fill)!;
      const ys = (plume.d.match(/[ML](-?[\d.]+) (-?[\d.]+)/g) ?? []).map((m) => Number(m.split(" ")[1]));
      return Math.min(...ys);
    };
    expect(plumeTop(SCENE_STILL_TIME["zanger-breakout"]!)).toBeLessThan(48);
    const resting = sceneFrame("zanger-breakout", 360, 120, 1).paths.find((p) => p.tone === "amber" && !p.fill);
    expect(resting).toBeUndefined();

    // The meter's needle has settled on the high reading by the still.
    const needle = (t: number) => {
      const frame = sceneFrame("quality-compounders", 360, 120, t);
      const line = frame.paths.find((p) => p.tone === "rust")!;
      const [, , x2] = (line.d.match(/-?[\d.]+/g) ?? []).map(Number);
      return x2!;
    };
    expect(needle(SCENE_STILL_TIME["quality-compounders"]!)).toBeGreaterThan(180);
    expect(needle(0)).toBeLessThan(180);
  });

  it("gives NaN time the first frame rather than NaN paths", () => {
    expect(sceneFrame("canslim", 360, 120, Number.NaN)).toEqual(sceneFrame("canslim", 360, 120, 0));
  });
});
