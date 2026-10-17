import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { StrategyBezel, StrategyGlyph } from "../strategy-glyph";
import { GLYPH_VIEWBOX, STRATEGY_GLYPHS } from "~/@/lib/strategies/glyphs";
import { STRATEGY_SLUGS } from "~/@/lib/strategies/registry";

describe("STRATEGY_GLYPHS", () => {
  it("draws every registry strategy, and nothing the registry lacks", () => {
    expect(Object.keys(STRATEGY_GLYPHS).sort()).toEqual([...STRATEGY_SLUGS].sort());
  });

  // Five silhouettes must stay distinguishable at 20px: no two glyphs share
  // a path, and each has at least two strokes of its own.
  it("gives each strategy its own strokes, on the 24-grid", () => {
    const seen = new Set<string>();
    for (const slug of STRATEGY_SLUGS) {
      const paths = STRATEGY_GLYPHS[slug]!;
      expect(paths.length).toBeGreaterThanOrEqual(2);
      for (const d of paths) {
        expect(seen.has(d)).toBe(false);
        seen.add(d);
        // Only path commands and numbers: no text, no colour, no script.
        expect(d).toMatch(/^[MLHVACZmlhvacz0-9 .,-]+$/);
        // Absolute coordinates sit on the grid; a relative arc (the meter's
        // pivot ring) may step backwards by up to the grid's width.
        for (const n of d.match(/-?\d+(?:\.\d+)?/g) ?? []) {
          const value = Number(n);
          expect(value).toBeGreaterThanOrEqual(-24);
          expect(value).toBeLessThanOrEqual(24);
        }
      }
    }
    expect(GLYPH_VIEWBOX).toBe("0 0 24 24");
  });

  it("is serialisable data: strings only, no functions", () => {
    const source = readFileSync(
      join(__dirname, "..", "..", "..", "lib", "strategies", "glyphs.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/=>|\bfunction\b|import /);
  });
});

describe("StrategyGlyph", () => {
  it("renders a decorative, stroke-only SVG with a non-scaling hairline", () => {
    const { container } = render(
      <StrategyGlyph slug="zanger-breakout" className="h-5 w-5" />,
    );
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("focusable", "false");
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24");
    expect(svg).toHaveAttribute("fill", "none");
    expect(svg).toHaveAttribute("stroke", "currentColor");
    expect(svg).toHaveAttribute("stroke-width", "1.5");
    expect(svg).toHaveAttribute("data-strategy-glyph", "zanger-breakout");
    expect(svg.className.baseVal).toContain("h-5 w-5");
    const paths = svg.querySelectorAll("path");
    expect(paths).toHaveLength(STRATEGY_GLYPHS["zanger-breakout"]!.length);
    for (const path of paths) {
      expect(path).toHaveAttribute("vector-effect", "non-scaling-stroke");
    }
    expect(svg.textContent).toBe("");
  });

  it("draws nothing for a strategy it does not know", () => {
    const { container } = render(<StrategyGlyph slug="not-a-strategy" />);
    expect(container.innerHTML).toBe("");
  });

  it("sits in a 56px bezel at the large size, a shade heavier and engraving itself on load", () => {
    const { container } = render(<StrategyBezel slug="canslim" />);
    const bezel = container.firstElementChild!;
    expect(bezel).toHaveAttribute("aria-hidden", "true");
    expect(bezel.className).toContain("h-14 w-14");
    const svg = bezel.querySelector("svg")!;
    expect(svg.className.baseVal).toContain("h-10 w-10");
    expect(svg).toHaveAttribute("stroke-width", "1.75");
    const paths = [...svg.querySelectorAll("path")];
    for (const [index, path] of paths.entries()) {
      expect(path).toHaveAttribute("pathLength", "1");
      expect(path).toHaveAttribute("stroke-dasharray", "1");
      expect(path.getAttribute("class")).toContain("motion-safe:animate-trace-draw");
      expect(path.style.animationDelay).toBe(`${index * 50}ms`);
    }
    // Five strokes at most, 50ms apart, 360ms each: finished under 600ms.
    expect(paths.length).toBeLessThanOrEqual(5);
  });

  it("draws at rest, with the hairline stroke, unless asked to engrave", () => {
    const { container } = render(<StrategyGlyph slug="canslim" />);
    const path = container.querySelector("path")!;
    expect(container.querySelector("svg")).toHaveAttribute("stroke-width", "1.5");
    expect(path).not.toHaveAttribute("pathLength");
    expect(path).not.toHaveAttribute("stroke-dasharray");
    expect(path.getAttribute("class")).toBeNull();
  });
});
