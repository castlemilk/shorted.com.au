import { layoutLevels } from "../chart-levels";

// x: 10 ms per px over a 0..1000 ms domain (0..100 px); y: 100 - value.
const x = (t: number) => t / 10;
const yFor = () => (v: number) => 100 - v;
const base = { x, yFor, innerW: 100, innerH: 100, levels: [], bands: [], markers: [] };

describe("layoutLevels", () => {
  it("spans a level across the plot when it has no range, and clamps a ranged one", () => {
    const { levels } = layoutLevels({
      ...base,
      levels: [
        { axis: "left", value: 40, label: "SMA 200 $40", color: "#f00" },
        { axis: "left", value: 60, label: "Pivot $60", color: "#0f0", from: -500, to: 300, dash: "4,3" },
      ],
    });
    // Each label also gets a place: its right edge 4px inside the line's end (the
    // short line leaves "Pivot $60" no room, so it moves right to 54, its
    // estimated width) and its baseline 4px above the line.
    expect(levels).toEqual([
      { x1: 0, x2: 100, y: 60, labelX: 96, labelY: 56, label: "SMA 200 $40", color: "#f00", dash: undefined },
      { x1: 0, x2: 30, y: 40, labelX: 54, labelY: 36, label: "Pivot $60", color: "#0f0", dash: "4,3" },
    ]);
  });

  it("drops a level outside the plot or with no visible width", () => {
    const { levels } = layoutLevels({
      ...base,
      levels: [
        { axis: "left", value: 150, label: "above", color: "#000" },
        { axis: "left", value: 50, label: "before", color: "#000", from: -900, to: -100 },
        { axis: "left", value: 50, label: "after", color: "#000", from: 1200, to: 1400 },
      ],
    });
    expect(levels).toEqual([]);
  });

  it("clips a band that starts before the domain and drops one entirely outside", () => {
    const { bands } = layoutLevels({
      ...base,
      bands: [
        { axis: "left", low: 20, high: 30, from: -400, to: 400, color: "#00f", label: "base" },
        { axis: "left", low: 20, high: 30, from: 2000, to: 3000, color: "#00f" },
      ],
    });
    expect(bands).toEqual([{ x: 0, y: 70, width: 40, height: 10, color: "#00f", label: "base" }]);
  });

  it("keeps markers inside the plot only", () => {
    const { markers } = layoutLevels({
      ...base,
      markers: [
        { t: 250, label: "breakout", color: "#f90" },
        { t: 5000, label: "gone", color: "#f90" },
      ],
    });
    expect(markers).toEqual([{ x: 25, labelX: 29, labelAnchor: "start", label: "breakout", color: "#f90" }]);
  });

  it("uses the right axis scale for right-axis levels", () => {
    const yRight = (v: number) => 200 - v;
    const { levels } = layoutLevels({
      ...base,
      yFor: (axis) => (axis === "right" ? yRight : (v: number) => 100 - v),
      innerH: 200,
      levels: [{ axis: "right", value: 50, label: "5% short", color: "#000" }],
    });
    expect(levels[0]!.y).toBe(150);
  });
});

// The rules the five tests above leave open: inclusive plot edges, the other
// side of each bound, bounds given the wrong way round, and the guards for a
// scale that cannot place a value.
describe("layoutLevels edges", () => {
  it("keeps a level on the plot edge and drops one below the plot or one the scale cannot place", () => {
    const { levels } = layoutLevels({
      ...base,
      levels: [
        { axis: "left", value: 100, label: "top edge", color: "#000" },
        { axis: "left", value: 0, label: "bottom edge", color: "#000" },
        { axis: "left", value: -20, label: "below", color: "#000" },
        { axis: "left", value: NaN, label: "unplaceable", color: "#000" },
      ],
    });
    expect(levels.map((l) => [l.label, l.y])).toEqual([
      ["top edge", 0],
      ["bottom edge", 100],
    ]);
  });

  it("lays out a band that starts inside the plot, whichever way round its bounds are given", () => {
    const band = { axis: "left" as const, from: 200, to: 600, color: "#00f" };
    const { bands } = layoutLevels({
      ...base,
      bands: [
        { ...band, low: 20, high: 30 },
        { ...band, low: 30, high: 20 },
      ],
    });
    const expected = { x: 20, y: 70, width: 40, height: 10, color: "#00f", label: undefined };
    expect(bands).toEqual([expected, expected]);
  });

  it("clips a band to the plot vertically, drops one with no height and reads its own axis", () => {
    const yRight = (v: number) => 200 - v;
    const { bands } = layoutLevels({
      ...base,
      yFor: (axis) => (axis === "right" ? yRight : (v: number) => 100 - v),
      innerH: 200,
      bands: [
        { axis: "left", low: 90, high: 250, from: 0, to: 500, color: "#00f" },
        { axis: "left", low: 300, high: 320, from: 0, to: 500, color: "#00f" },
        { axis: "right", low: 50, high: 60, from: 0, to: 500, color: "#00f" },
      ],
    });
    expect(bands.map((b) => [b.y, b.height])).toEqual([
      [0, 10],
      [140, 10],
    ]);
  });

  it("drops a marker before the domain and one the scale cannot place", () => {
    const { markers } = layoutLevels({
      ...base,
      x: (t) => (t === 7 ? NaN : t / 10),
      markers: [
        { t: -100, label: "before", color: "#f90" },
        { t: 7, label: "unplaceable", color: "#f90" },
        { t: 0, label: "first session", color: "#f90" },
      ],
    });
    expect(markers).toEqual([{ x: 0, labelX: 4, labelAnchor: "start", label: "first session", color: "#f90" }]);
  });

  it("drops a band the scale cannot place on either bound", () => {
    const { bands } = layoutLevels({
      ...base,
      yFor: () => (v) => (v === 25 ? NaN : 100 - v),
      bands: [
        { axis: "left", low: 20, high: 25, from: 0, to: 500, color: "#00f" },
        { axis: "left", low: 25, high: 30, from: 0, to: 500, color: "#00f" },
        { axis: "left", low: 20, high: 30, from: 0, to: 500, color: "#00f", label: "placeable" },
      ],
    });
    expect(bands).toEqual([{ x: 0, y: 70, width: 50, height: 10, color: "#00f", label: "placeable" }]);
  });

  it("drops a level or band whose time bound the scale cannot place, rather than start it at the plot edge", () => {
    const { levels, bands } = layoutLevels({
      ...base,
      x: (t) => (t === 7 ? NaN : t / 10),
      levels: [
        { axis: "left", value: 50, label: "no start", color: "#000", from: 7, to: 500 },
        { axis: "left", value: 50, label: "no end", color: "#000", from: 100, to: 7 },
        { axis: "left", value: 50, label: "placeable", color: "#000", from: 100, to: 500 },
      ],
      bands: [
        { axis: "left", low: 20, high: 30, from: 7, to: 500, color: "#00f" },
        { axis: "left", low: 20, high: 30, from: 100, to: 7, color: "#00f" },
      ],
    });
    expect(levels.map((l) => l.label)).toEqual(["placeable"]);
    expect(bands).toEqual([]);
  });
});

// Where the labels go. They are laid out with the geometry, so the chart only
// has to draw them: spread apart, and inside the plot.
describe("layoutLevels labels", () => {
  // 200 px wide (x: 5 ms per px), so a marker's label always fits on one side of its line.
  const wide = { ...base, x: (t: number) => t / 5, innerW: 200 };
  const level = (value: number, label = `L${value}`) => ({ axis: "left" as const, value, label, color: "#000" });
  const SPACING = 11; // the closest two level labels' baselines may sit

  it("spreads crowded labels in order of position and leaves every line where its value puts it", () => {
    // y = 100 - value: five lines within 10 px of each other, given out of order.
    const { levels } = layoutLevels({ ...base, levels: [47, 50, 40, 48, 44].map((v) => level(v)) });
    expect(levels.map((l) => l.y)).toEqual([53, 50, 60, 52, 56]);
    // Sorted by y the baselines are 46, 57, 68, 79, 90: the first keeps its place (4 px above
    // its line) and each of the rest drops to 11 px below the one above. Still in the order given.
    expect(levels.map((l) => l.labelY)).toEqual([68, 46, 90, 57, 79]);
    const sorted = levels.map((l) => l.labelY).sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i]! - sorted[i - 1]!).toBeGreaterThanOrEqual(SPACING);
    }
  });

  it("leaves labels that are already clear of each other 4 px above their lines", () => {
    const { levels } = layoutLevels({ ...base, levels: [level(80), level(60), level(40)] });
    expect(levels.map((l) => [l.y, l.labelY])).toEqual([
      [20, 16],
      [40, 36],
      [60, 56],
    ]);
  });

  it("moves a label only when it is closer than 11 px to the one above it", () => {
    // Lines 10 px apart put their labels 10 px apart, so the lower one moves; 11 px apart is clear.
    const near = layoutLevels({ ...base, levels: [level(50), level(40)] }).levels;
    expect(near.map((l) => l.labelY - l.y)).toEqual([-4, -3]);
    const apart = layoutLevels({ ...base, levels: [level(50), level(39)] }).levels;
    expect(apart.map((l) => l.labelY - l.y)).toEqual([-4, -4]);
  });

  it("gives two levels at the same value a label each", () => {
    const { levels } = layoutLevels({ ...base, levels: [level(50, "first"), level(50, "second")] });
    expect(levels.map((l) => [l.label, l.y, l.labelY])).toEqual([
      ["first", 50, 46],
      ["second", 50, 57],
    ]);
  });

  it("does not let a level that is not drawn push the labels of those that are", () => {
    const hidden = { ...level(50, "hidden"), from: 2000, to: 3000 }; // after the plot
    const { levels } = layoutLevels({ ...base, levels: [hidden, level(50, "shown")] });
    expect(levels.map((l) => [l.label, l.labelY])).toEqual([["shown", 46]]);
  });

  it("pulls a stack that would run off the bottom of the plot back up", () => {
    // The lowest label may sit where the label of a line on the floor would: 96 in a 100 px plot.
    const { levels } = layoutLevels({ ...base, levels: [level(4), level(3), level(2)] });
    expect(levels.map((l) => l.y)).toEqual([96, 97, 98]);
    expect(levels.map((l) => l.labelY)).toEqual([74, 85, 96]);
  });

  it("ends a level's label 4 px inside the line, and moves it right when the line leaves no room", () => {
    const { levels } = layoutLevels({
      ...wide,
      levels: [
        level(50, "Pivot $60"), // the whole width: ends at 196
        { ...level(40, "Pivot $60"), from: 0, to: 100 }, // the line ends at 20, the label needs 54
        level(30, "x".repeat(50)), // 300 px of text in a 200 px plot
      ],
    });
    expect(levels.map((l) => l.labelX)).toEqual([196, 54, 200]);
  });

  it("keeps a level's label inside the plot wherever the line ends", () => {
    const width = 66; // "SMA 200 $40": 11 characters at 6 px
    const outside: number[] = [];
    for (let to = 5; to <= 1000; to += 5) {
      // the line's end sweeps from 1 px to the plot's edge
      const [l] = layoutLevels({ ...wide, levels: [{ ...level(50, "SMA 200 $40"), from: -100, to }] }).levels;
      const inside = l!.labelX - width >= 0 && l!.labelX <= 200; // false for a label with no place
      if (!inside) outside.push(to);
    }
    expect(outside).toEqual([]);
  });

  it("flips a marker's label to end-anchored where the right has no room for it", () => {
    // "breakout" needs about 52 px beside its line.
    const { markers } = layoutLevels({
      ...wide,
      markers: [0, 250, 900, 1000].map((t) => ({ t, label: "breakout", color: "#f90" })),
    });
    expect(markers.map((m) => [m.x, m.labelX, m.labelAnchor])).toEqual([
      [0, 4, "start"],
      [50, 54, "start"],
      [180, 176, "end"],
      [200, 196, "end"],
    ]);
  });

  it("keeps a marker's label inside the plot when neither side of the line holds it", () => {
    // "breakout" is 48 px in a 100 px plot. At x = 48 it just fits on the right (52 to 100);
    // at x = 49 it does not, and the left of the line (45 - 48) does not either, so the label
    // is end-anchored at 48 and ends beside the line instead of leaving the plot.
    const { markers } = layoutLevels({
      ...base,
      markers: [480, 490, 600].map((t) => ({ t, label: "breakout", color: "#f90" })),
    });
    expect(markers.map((m) => [m.x, m.labelX, m.labelAnchor])).toEqual([
      [48, 52, "start"],
      [49, 48, "end"],
      [60, 56, "end"],
    ]);
  });

  it("keeps a marker's label inside the plot wherever the marker is", () => {
    const width = 48; // "breakout": 8 characters at 6 px
    const outside: number[] = [];
    for (let t = 0; t <= 1000; t += 10) {
      const [m] = layoutLevels({ ...wide, markers: [{ t, label: "breakout", color: "#f90" }] }).markers;
      const [from, to] = m!.labelAnchor === "start" ? [m!.labelX, m!.labelX + width] : [m!.labelX - width, m!.labelX];
      const inside = from >= 0 && to <= 200; // false for a label with no place
      if (!inside) outside.push(t);
    }
    expect(outside).toEqual([]);
  });
});
