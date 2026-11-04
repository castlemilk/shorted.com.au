/// <reference types="jest" />

/**
 * The critique pass's motion rules (spec 14.9): the bridge's spring easing is the standard
 * ease (no overshoot), and the vendored data table transitions colour and opacity only.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(__dirname, "..");
const read = (name: string) => readFileSync(join(dir, name), "utf8");

describe("gamma motion tokens (spec 14.9)", () => {
  it("makes the spring easing the standard ease, with no overshoot", () => {
    const bridge = read("gamma-bridge.css");
    const spring = bridge.match(/--gamma-ease-spring:\s*([^;]+);/g) ?? [];
    expect(spring.length).toBeGreaterThan(0);
    for (const declaration of spring) {
      expect(declaration).not.toMatch(/1\.3/);
      expect(declaration).toContain("cubic-bezier(0.2, 0.8, 0.2, 1)");
    }
  });

  it("transitions only colour and opacity in the data table", () => {
    const css = read("DataTable.css");
    const properties = [...css.matchAll(/transition-property:\s*([^;]+);/g)].map((m) => m[1]!.replace(/\s+/g, " ").trim());
    expect(properties.length).toBeGreaterThan(0);
    for (const value of properties) {
      expect(value).not.toMatch(/\bwidth\b|\btransform\b|\bscale\b|\btranslate\b|\brotate\b/);
    }
  });

  it("keeps the data table's own transition classes to colour and opacity", () => {
    const tsx = read("DataTable.tsx");
    expect(tsx).not.toMatch(/transition-\[width\]/);
    expect(tsx).not.toMatch(/transition-\[transform,/);
    expect(tsx).not.toMatch(/active:scale-/);
  });
});
