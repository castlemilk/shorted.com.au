import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  OVERLAY_BY_KEY, PLANNING_HERITAGE_STATES, PLANNING_ZONING_STATES, overlayAssetUrl, overlayAvailable,
  overlayClassFor, parseOverlayParam,
} from "./overlays";
import { ZONE_FAMILIES, ZONE_FAMILY_COLORS, ZONE_FAMILY_LABELS } from "./zone-families";

const publicDir = join(__dirname, "../../../../public");
const planningDir = join(publicDir, "geo/planning");
const MAX_BYTES = 1_200_000; // web/scripts/geo/planning/build-overlays.mjs

type Topo = {
  properties?: Record<string, string>;
  objects: Record<string, { geometries: { properties?: Record<string, unknown> }[] }>;
};
const read = (file: string): Topo => JSON.parse(readFileSync(join(planningDir, file), "utf8")) as Topo;

describe("planning overlays", () => {
  test("zoning is the categorical layer, with one class per harmonised family", () => {
    const zoning = OVERLAY_BY_KEY.zoning;
    expect(zoning.kind).toBe("categorical");
    expect(zoning.classProperty).toBe("family");
    expect(zoning.classes?.map((c) => c.value)).toEqual([...ZONE_FAMILIES]);
    for (const c of zoning.classes ?? []) {
      expect(c.color).toBe(ZONE_FAMILY_COLORS[c.value as keyof typeof ZONE_FAMILY_COLORS]);
      expect(c.label).toBe(ZONE_FAMILY_LABELS[c.value as keyof typeof ZONE_FAMILY_LABELS]);
    }
    expect(overlayClassFor("zoning", "res_low")?.label).toBe("Low-density residential");
    expect(overlayClassFor("zoning", "nonsense")).toBeUndefined();
    expect(overlayClassFor("heritage", "res_low")).toBeUndefined();
    // Existing binary hazard layers are untouched by the categorical path.
    expect(OVERLAY_BY_KEY.flood_planning.kind).toBeUndefined();
  });

  test("planning assets live under /geo/planning, hazards stay under /geo/hazards", () => {
    expect(overlayAssetUrl("NSW", "zoning")).toBe("/geo/planning/NSW-zoning.topojson");
    expect(overlayAssetUrl("VIC", "heritage")).toBe("/geo/planning/VIC-heritage.topojson");
    expect(overlayAssetUrl("NSW", "flood_planning")).toBe("/geo/hazards/NSW-flood_planning.topojson");
  });

  test("every committed planning asset is advertised, and nothing else is in the directory", () => {
    const files = readdirSync(planningDir).filter((f) => f.endsWith(".topojson")).sort();
    const expected = [
      ...PLANNING_ZONING_STATES.map((s) => `${s}-zoning.topojson`),
      ...PLANNING_HERITAGE_STATES.map((s) => `${s}-heritage.topojson`),
    ].sort();
    expect(files).toEqual(expected);
    for (const state of ["QLD", "WA", "NT"]) {
      expect(overlayAvailable("zoning", state)).toBe(false);
      expect(existsSync(join(publicDir, overlayAssetUrl(state, "zoning")))).toBe(false);
    }
  });

  test.each(PLANNING_ZONING_STATES.map((s) => [s]))("%s zoning: one feature per family, stamped, under budget", (state) => {
    const file = `${state}-zoning.topojson`;
    expect(statSync(join(planningDir, file)).size).toBeLessThanOrEqual(MAX_BYTES);
    const topo = read(file);
    expect(topo.properties).toMatchObject({ layer: "zoning", state });
    expect(topo.properties?.source?.length).toBeGreaterThan(5);
    expect(topo.properties?.licence).toMatch(/^CC-BY-/);
    expect(topo.properties?.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const geometries = Object.values(topo.objects)[0]!.geometries;
    const families = geometries.map((g) => g.properties?.family);
    expect(new Set(families).size).toBe(families.length);
    for (const f of families) expect(ZONE_FAMILIES).toContain(f);
    // Every state has residential land and open space; a missing one means
    // the dissolve or the family map dropped it.
    expect(families).toEqual(expect.arrayContaining(["res_low", "res_medium_high", "open_space"]));
  });

  test.each(PLANNING_HERITAGE_STATES.map((s) => [s]))("%s heritage: one binary feature, stamped, under budget", (state) => {
    const file = `${state}-heritage.topojson`;
    expect(statSync(join(planningDir, file)).size).toBeLessThanOrEqual(MAX_BYTES);
    const topo = read(file);
    expect(topo.properties).toMatchObject({ layer: "heritage", state });
    expect(topo.properties?.licence).toMatch(/^CC-BY-/);
    expect(Object.values(topo.objects)[0]!.geometries).toHaveLength(1);
  });

  test("the URL parameter accepts the planning layers", () => {
    expect(parseOverlayParam("heritage,zoning,junk")).toEqual(["zoning", "heritage"]);
  });
});
