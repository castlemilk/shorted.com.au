import { layoutPointMarks, type PointMarkInput } from "../chart-events";

// A linear scale: 1 px per day, 1 px per value unit, value 0 at the foot.
const opts = {
  x: (t: number) => t,
  yFor: () => (v: number) => 100 - v,
  innerW: 200,
  innerH: 100,
};

const item = (over: Partial<PointMarkInput> = {}): PointMarkInput => ({
  kind: "event",
  t: 50,
  v: 50,
  axis: "left",
  fill: "hsl(var(--primary))",
  ...over,
});

describe("layoutPointMarks", () => {
  it("places a dot at the point's pixel position", () => {
    const [mark] = layoutPointMarks([item({ t: 40, v: 30 })], opts);
    expect(mark).toMatchObject({ kind: "event", x: 40, y: 70 });
  });

  it("puts a label to the right of its dot, above the dot", () => {
    const [mark] = layoutPointMarks([item({ label: "Exit" })], opts);
    expect(mark).toMatchObject({
      labelX: 56,
      labelY: 44,
      labelAnchor: "start",
    });
  });

  it("moves a label to the dot's left where the right has no room", () => {
    const [mark] = layoutPointMarks(
      [item({ t: 190, label: "Exit date" })],
      opts,
    );
    expect(mark).toMatchObject({ labelAnchor: "end", labelX: 184 });
  });

  it("drops a label below its dot where the top of the plot is too near", () => {
    const [mark] = layoutPointMarks([item({ v: 95, label: "Entry" })], opts);
    expect(mark!.labelY).toBe(mark!.y + 14);
  });

  it("keeps the kind of each mark", () => {
    const marks = layoutPointMarks(
      [
        item({ kind: "event" }),
        item({ kind: "annotation", t: 80, label: "−18.6%" }),
      ],
      opts,
    );
    expect(marks.map((m) => m.kind)).toEqual(["event", "annotation"]);
  });

  it("drops a dot the scale cannot place or that lies off the plot", () => {
    const marks = layoutPointMarks(
      [
        item({ t: Number.NaN }),
        item({ t: -10 }),
        item({ t: 260 }),
        item({ v: 150 }),
        item({ t: 50, v: 50 }),
      ],
      opts,
    );
    expect(marks).toHaveLength(1);
  });

  it("reads each mark against its own axis", () => {
    const marks = layoutPointMarks([item({ axis: "right", v: 20 })], {
      ...opts,
      yFor: (axis) => (v) => (axis === "right" ? 200 - v : 100 - v),
    });
    // On the right axis 20 sits at 180, off the 100px plot: dropped, not drawn on the edge.
    expect(marks).toHaveLength(0);
  });
});
