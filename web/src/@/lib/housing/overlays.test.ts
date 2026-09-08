import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_STATES_WITH_WATER, OVERLAYS, overlayAssetUrl, overlayAvailable,
  parseOverlayParam, serializeOverlayParam,
} from "./overlays";

const publicDir = join(__dirname, "../../../../public");

describe("overlay registry", () => {
  test("every advertised state has a committed asset, and no asset is unadvertised", () => {
    for (const overlay of OVERLAYS) {
      for (const state of ALL_STATES_WITH_WATER) {
        const path = join(publicDir, overlayAssetUrl(state, overlay.key));
        const advertised = overlayAvailable(overlay.key, state);
        expect({ key: overlay.key, state, exists: existsSync(path) }).toEqual({
          key: overlay.key, state, exists: advertised,
        });
      }
    }
  });

  test("every layer carries a caveat and a source, because the legend shows them", () => {
    for (const overlay of OVERLAYS) {
      expect(overlay.caveat.length).toBeGreaterThan(20);
      expect(overlay.source.length).toBeGreaterThan(5);
    }
  });

  test("the satellite layer never calls itself flood risk", () => {
    const water = OVERLAYS.find((o) => o.key === "water_observed")!;
    expect(`${water.label} ${water.shareLabel} ${water.caveat}`).not.toMatch(/flood risk/i);
    expect(water.label).toMatch(/observed/i);
  });

  test("the URL parameter round-trips in registry order and drops junk", () => {
    expect(parseOverlayParam("water_observed,junk,flood_planning,flood_planning")).toEqual([
      "flood_planning", "water_observed",
    ]);
    expect(parseOverlayParam(null)).toEqual([]);
    expect(serializeOverlayParam(["water_observed", "flood_planning"])).toBe("flood_planning,water_observed");
  });
});
