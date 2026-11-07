import { compareGeometry } from "../compare-geometry";

describe("compareGeometry", () => {
  it("draws every curve on one shared scale, so the lines compare by eye", () => {
    const geometry = compareGeometry(
      [
        { key: "a", points: [{ t: 0, v: 100 }, { t: 10, v: 200 }] },
        { key: "b", points: [{ t: 0, v: 150 }, { t: 10, v: 150 }] },
      ],
      100,
      100,
      0,
    );
    expect(geometry.yMin).toBe(100);
    expect(geometry.yMax).toBe(200);
    // a runs bottom to top on the shared 100 to 200 scale; b sits half way up.
    expect(geometry.paths[0]!.d).toBe("M0 100 L100 0");
    expect(geometry.paths[1]!.d).toBe("M0 50 L100 50");
  });

  it("skips a missing or non-finite point and draws nothing for a curve with none", () => {
    const geometry = compareGeometry(
      [
        { key: "a", points: [{ t: 0, v: null }, { t: 1, v: 10 }, { t: 2, v: 20 }] },
        { key: "b", points: [{ t: 0, v: null }] },
      ],
      100,
      100,
    );
    expect(geometry.paths[0]!.d.startsWith("M")).toBe(true);
    expect(geometry.paths[1]!.d).toBe("");
  });

  it("reports no domain when no curve has a point", () => {
    expect(compareGeometry([{ key: "a", points: [] }], 10, 10)).toEqual({
      paths: [{ key: "a", d: "" }],
      yMin: null,
      yMax: null,
    });
  });
});
