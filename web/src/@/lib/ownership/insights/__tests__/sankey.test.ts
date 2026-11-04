import { flowPath, layoutFlow } from "../sankey";
import { FLOW } from "./fixtures";

describe("the money flow's geometry", () => {
  const layout = layoutFlow(FLOW, 900, 400, { left: 0, right: 160 });

  it("keeps each node in its column: kinds left, institutions middle, sectors right", () => {
    const x = (column: number) => [...new Set(layout.nodes.filter((n) => n.column === column).map((n) => n.x0))];
    expect(x(0)).toHaveLength(1);
    expect(x(1)).toHaveLength(1);
    expect(x(2)).toHaveLength(1);
    expect(x(0)[0]!).toBeLessThan(x(1)[0]!);
    expect(x(1)[0]!).toBeLessThan(x(2)[0]!);
    expect(Math.max(...layout.nodes.map((n) => n.x1))).toBeLessThanOrEqual(900 - 160);
  });

  it("stacks a column by value, inside the box, with a ribbon per link", () => {
    const middle = layout.nodes.filter((n) => n.column === 1).sort((a, b) => a.y0 - b.y0);
    expect(middle.map((n) => n.label)).toEqual(["Vanguard", "Hostplus", "BlackRock"]);
    for (const n of layout.nodes) {
      expect(n.y0).toBeGreaterThanOrEqual(0);
      expect(n.y1).toBeLessThanOrEqual(400);
    }
    expect(layout.links).toHaveLength(FLOW.links.length);
    for (const l of layout.links) {
      expect(l.path).toMatch(/^M/);
      expect(l.width).toBeGreaterThanOrEqual(1);
    }
  });

  it("lights every path through a node, both ways", () => {
    const vanguard = layout.nodes.find((n) => n.id === "inst:vanguard")!;
    const path = flowPath(layout, vanguard.index);
    const labels = [...path.nodes].map((i) => FLOW.nodes[i]!.label).sort();
    expect(labels).toEqual(["Banks", "Materials", "Vanguard", "index_manager"]);
    expect(path.links.size).toBe(3);
  });

  it("lays out nothing without links or a box", () => {
    expect(layoutFlow({ ...FLOW, links: [] }, 900, 400).nodes).toEqual([]);
    expect(layoutFlow(FLOW, 0, 400).nodes).toEqual([]);
  });
});
