import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ZONE_FAMILIES, ZONE_FAMILY_COLORS, ZONE_FAMILY_LABELS, ZONE_FAMILY_SHORT, zoneFamilyColorForLabel,
} from "./zone-families";

const repo = join(__dirname, "../../../../..");

describe("zone families", () => {
  test("match the Go registry order and labels, which the categorical column indexes into", () => {
    const go = readFileSync(join(repo, "services/shorts/internal/store/shorts/postgres_house_prices.go"), "utf8");
    const families = go.match(/var ZoneFamilies = \[\]string\{([\s\S]*?)\}/)?.[1];
    expect(families).toBeDefined();
    expect([...families!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...ZONE_FAMILIES]);

    const columns = readFileSync(join(repo, "services/shorts/internal/store/shorts/postgres_suburb_columns.go"), "utf8");
    const labels = columns.match(/var ZoneFamilyLabels = \[\]string\{([\s\S]*?)\}/)?.[1];
    expect(labels).toBeDefined();
    expect([...labels!.matchAll(/"([^"]+)"/g)].map((m) => m[1])).toEqual(ZONE_FAMILIES.map((f) => ZONE_FAMILY_LABELS[f]));
  });

  test("match the offline build's family set", () => {
    const py = readFileSync(join(repo, "web/scripts/geo/planning/zone_families.py"), "utf8");
    const block = py.match(/FAMILIES: tuple\[str, \.\.\.\] = \(([\s\S]*?)\)/)?.[1];
    expect([...block!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1])).toEqual([...ZONE_FAMILIES]);
  });

  test("every family has a distinct colour and a label", () => {
    const colours = ZONE_FAMILIES.map((f) => ZONE_FAMILY_COLORS[f]);
    expect(new Set(colours).size).toBe(colours.length);
    for (const f of ZONE_FAMILIES) {
      expect(ZONE_FAMILY_LABELS[f].length).toBeGreaterThan(3);
      expect(ZONE_FAMILY_SHORT[f].length).toBeGreaterThan(3);
    }
  });

  test("a server category label resolves to its family colour", () => {
    expect(zoneFamilyColorForLabel("Low-density residential")).toBe(ZONE_FAMILY_COLORS.res_low);
    expect(zoneFamilyColorForLabel("Not a family")).toBe("#cccccc");
  });
});
