import { layoutEndLabels } from "../end-labels";

const item = (id: string, y: number, text = id) => ({
  id,
  y,
  text,
  color: "#123456",
});

describe("layoutEndLabels", () => {
  it("end-anchors each label just inside the plot's right edge", () => {
    const [label] = layoutEndLabels([item("strategy", 60)], {
      innerW: 300,
      innerH: 200,
    });
    expect(label).toMatchObject({ id: "strategy", x: 296 });
  });

  it("sits the label 4px above its point", () => {
    const [label] = layoutEndLabels([item("strategy", 60)], {
      innerW: 300,
      innerH: 200,
    });
    expect(label!.y).toBe(56);
  });

  it("spreads two labels whose ends are level, so neither overlaps the other", () => {
    const [a, b] = layoutEndLabels([item("a", 60), item("b", 61)], {
      innerW: 300,
      innerH: 200,
    });
    expect(Math.abs(a!.y - b!.y)).toBeGreaterThanOrEqual(11);
  });

  it("keeps a label at the top of the plot inside it", () => {
    const [label] = layoutEndLabels([item("top", 2)], {
      innerW: 300,
      innerH: 200,
    });
    expect(label!.y).toBeGreaterThanOrEqual(10);
  });

  it("writes no label for a point the scale could not place, or that lies off the plot", () => {
    const labels = layoutEndLabels(
      [
        item("nan", Number.NaN),
        item("above", -5),
        item("below", 260),
        item("ok", 80),
      ],
      { innerW: 300, innerH: 200 },
    );
    expect(labels.map((l) => l.id)).toEqual(["ok"]);
  });

  it("returns nothing for no series", () => {
    expect(layoutEndLabels([], { innerW: 300, innerH: 200 })).toEqual([]);
  });

  it("carries the text and colour it was given", () => {
    const [label] = layoutEndLabels(
      [{ id: "s", y: 50, text: "$25,000", color: "#abcdef" }],
      {
        innerW: 300,
        innerH: 200,
      },
    );
    expect(label).toMatchObject({ text: "$25,000", color: "#abcdef" });
  });
});

describe("layoutEndLabels at the top of the plot", () => {
  it("stacks two labels at the top downward, never on one baseline", () => {
    const [a, b] = layoutEndLabels([item("a", 0), item("b", 2)], {
      innerW: 300,
      innerH: 200,
    });
    expect(a!.y).toBeGreaterThanOrEqual(10);
    expect(b!.y - a!.y).toBeGreaterThanOrEqual(11);
  });
});
