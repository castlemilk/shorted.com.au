import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  ALL_STATES_WITH_WATER, OVERLAYS, OVERLAY_BY_KEY, creditedOverlays, overlayAssetUrl, overlayAvailable, overlayCaveat,
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

  test("per-state notes and uncovered copy only name states that have the layer", () => {
    for (const overlay of OVERLAYS) {
      for (const bag of [overlay.stateNotes, overlay.stateCaveats, overlay.uncovered]) {
        for (const state of Object.keys(bag ?? {})) {
          expect({ key: overlay.key, state, available: overlayAvailable(overlay.key, state) })
            .toEqual({ key: overlay.key, state, available: true });
        }
      }
    }
  });

  test("a state whose source leaves suburbs uncovered says why instead of showing 0%", () => {
    // Every source with a coverage mask in vector_share.py: NSW (lodged EPI
    // flood maps), SA (the Code's unassessed overlays), TAS (LPS mapping),
    // ACT (modelled catchments).
    for (const state of ["NSW", "SA", "TAS", "ACT"]) {
      expect(OVERLAY_BY_KEY.flood_planning.uncovered?.[state]).toMatch(/\w{10}/);
    }
    for (const state of ["SA", "TAS"]) {
      expect(OVERLAY_BY_KEY.bushfire_prone.uncovered?.[state]).toMatch(/\w{10}/);
    }
    expect(OVERLAY_BY_KEY.flood_planning.stateNotes?.NSW).toMatch(/no statutory layer, not as 0%/);
  });

  test("the ACT flood model is never called a planning control, nor denied being a flood extent", () => {
    const act = overlayCaveat("flood_planning", "ACT");
    expect(act).toMatch(/modelled 1% AEP flood extent/);
    expect(act).not.toMatch(/not a flood extent/);
    expect(overlayCaveat("flood_planning", "NSW")).toMatch(/not a flood extent/);
  });

  test("VIC bushfire is the Designated Bushfire Prone Area, comparable with NSW", () => {
    const fire = OVERLAY_BY_KEY.bushfire_prone;
    expect(fire.source).toMatch(/VIC Designated Bushfire Prone Area/);
    expect(fire.source).not.toMatch(/BMO/);
    expect(overlayCaveat("bushfire_prone", "VIC")).toMatch(/like-for-like of NSW Bush Fire Prone Land/);
  });

  test("the URL parameter round-trips in registry order and drops junk", () => {
    expect(parseOverlayParam("water_observed,junk,flood_planning,flood_planning")).toEqual([
      "flood_planning", "water_observed",
    ]);
    expect(parseOverlayParam(null)).toEqual([]);
    expect(serializeOverlayParam(["water_observed", "flood_planning"])).toBe("flood_planning,water_observed");
  });
});

describe("creditedOverlays", () => {
  // The map page drew CC BY planning and hazard layers while its sources line
  // named only OSM/ABS/ACARA/GA/NBN/BOCSAR.
  test("credits every active overlay the state has", () => {
    expect(creditedOverlays("VIC", ["zoning"]).map((o) => o.key)).toEqual(["zoning"]);
    expect(creditedOverlays("NSW", ["heritage", "flood_planning"]).map((o) => o.key)).toEqual(["flood_planning", "heritage"]);
  });

  test("credits the layer behind a planning or hazard colour-by metric", () => {
    expect(creditedOverlays("VIC", [], "dominant_zone_family").map((o) => o.key)).toEqual(["zoning"]);
    expect(creditedOverlays("SA", [], "zone_res_low_share_pct").map((o) => o.key)).toEqual(["zoning"]);
    expect(creditedOverlays("NSW", [], "heritage_share_pct").map((o) => o.key)).toEqual(["heritage"]);
    expect(creditedOverlays("NSW", [], "bushfire_prone_share_pct").map((o) => o.key)).toEqual(["bushfire_prone"]);
  });

  test("credits nothing that is not drawn", () => {
    expect(creditedOverlays("NSW", [], "price")).toEqual([]);
    // QLD has no statewide zoning: nothing is drawn, so nothing is credited.
    expect(creditedOverlays("QLD", ["zoning"], "dominant_zone_family")).toEqual([]);
  });

  test("names each source once", () => {
    const keys = creditedOverlays("VIC", ["zoning"], "dominant_zone_family").map((o) => o.key);
    expect(keys).toEqual(["zoning"]);
  });
});
