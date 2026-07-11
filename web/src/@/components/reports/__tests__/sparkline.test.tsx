/// <reference types="jest" />

import React from "react";
import { render } from "@testing-library/react";
import { Sparkline, buildSparklineGeometry } from "../sparkline";

describe("buildSparklineGeometry", () => {
  it("returns null for empty, single-point and two-point series", () => {
    expect(buildSparklineGeometry([], 90, 24)).toBeNull();
    expect(buildSparklineGeometry([5.1], 90, 24)).toBeNull();
    expect(buildSparklineGeometry([5.1, 5.4], 90, 24)).toBeNull();
  });

  it("ignores non-finite values when deciding whether to render", () => {
    expect(buildSparklineGeometry([NaN, Infinity, 5.1], 90, 24)).toBeNull();
  });

  it("generates one coordinate pair per point, left to right", () => {
    const geometry = buildSparklineGeometry([1, 2, 3, 4, 5], 90, 24)!;
    const pairs = geometry.points.split(" ");
    expect(pairs).toHaveLength(5);

    const xs = pairs.map((p) => parseFloat(p.split(",")[0]!));
    // Monotonically increasing x across the padded width
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]!).toBeGreaterThan(xs[i - 1]!);
    }
    expect(xs[0]).toBeCloseTo(2.5); // left padding
    expect(xs[xs.length - 1]).toBeCloseTo(87.5); // width - padding
  });

  it("inverts the y-axis so higher values sit higher in the viewBox", () => {
    const geometry = buildSparklineGeometry([1, 5, 3], 90, 24)!;
    const ys = geometry.points.split(" ").map((p) => parseFloat(p.split(",")[1]!));
    // value 5 (max) has the SMALLEST y; value 1 (min) the LARGEST
    expect(ys[1]!).toBeLessThan(ys[0]!);
    expect(ys[1]!).toBeLessThan(ys[2]!);
    expect(ys[0]!).toBeGreaterThan(ys[2]!);
  });

  it("places the end dot at the last coordinate", () => {
    const geometry = buildSparklineGeometry([2, 4, 6, 8], 90, 24)!;
    const last = geometry.points.split(" ").pop()!;
    expect(last).toBe(`${geometry.end.x},${geometry.end.y}`);
  });

  it("renders a flat mid-height line for a constant series", () => {
    const geometry = buildSparklineGeometry([3, 3, 3, 3], 90, 24)!;
    const ys = geometry.points.split(" ").map((p) => parseFloat(p.split(",")[1]!));
    ys.forEach((y) => expect(y).toBe(12));
    expect(geometry.direction).toBe("flat");
  });

  it("classifies net direction from first to last point", () => {
    expect(buildSparklineGeometry([1, 9, 2], 90, 24)!.direction).toBe("up");
    expect(buildSparklineGeometry([9, 1, 3], 90, 24)!.direction).toBe("down");
  });
});

describe("Sparkline", () => {
  it("renders nothing for fewer than 3 points", () => {
    const { container } = render(<Sparkline data={[4.2, 4.5]} />);
    expect(container.firstChild).toBeNull();
  });

  it("colours rising short interest red (risk convention)", () => {
    const { container } = render(<Sparkline data={[2, 3, 4]} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("text-red-500");
    expect(svg.querySelector("polyline")).not.toBeNull();
    expect(svg.querySelector("circle")).not.toBeNull();
  });

  it("colours falling short interest green", () => {
    const { container } = render(<Sparkline data={[4, 3, 2]} />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("class")).toContain("text-green-600");
  });

  it("exposes an accessible trend label", () => {
    const { container } = render(<Sparkline data={[2, 3, 4]} label="BHP trend" />);
    const svg = container.querySelector("svg")!;
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("BHP trend");
  });
});
