import { describe, expect, it } from "vitest";
import { normalisePlanRoles, type PlanItem } from "./art-director.js";

function item(over: Partial<PlanItem> = {}): PlanItem {
  return {
    role: "inline",
    style: "documentary",
    ratio: "square",
    brief: "a drill core tray at the Kayelekera mine",
    caption: "Core samples, Kayelekera",
    placement: "inset",
    anchorAfterBlock: 1,
    ...over,
  };
}

describe("normalisePlanRoles", () => {
  it("returns [] for an empty plan", () => {
    expect(normalisePlanRoles([])).toEqual([]);
  });

  it("keeps a single hero, moved to index 0, forced landscape", () => {
    const plan = [
      item({ brief: "a" }),
      item({ role: "hero", ratio: "portrait", brief: "b" }),
      item({ brief: "c" }),
    ];
    const out = normalisePlanRoles(plan);
    expect(out).toHaveLength(3);
    expect(out[0]!.role).toBe("hero");
    expect(out[0]!.brief).toBe("b");
    expect(out[0]!.ratio).toBe("landscape");
    expect(out.filter((i) => i.role === "hero")).toHaveLength(1);
    // inline order + anchors preserved
    expect(out.slice(1).map((i) => i.brief)).toEqual(["a", "c"]);
  });

  it("no hero → promotes the first landscape item and moves it first", () => {
    const plan = [
      item({ brief: "a", ratio: "portrait" }),
      item({ brief: "b", ratio: "landscape" }),
      item({ brief: "c", ratio: "landscape" }),
    ];
    const out = normalisePlanRoles(plan);
    expect(out[0]!.role).toBe("hero");
    expect(out[0]!.brief).toBe("b");
    expect(out[0]!.ratio).toBe("landscape");
    expect(out.filter((i) => i.role === "hero")).toHaveLength(1);
    expect(out.slice(1).every((i) => i.role === "inline")).toBe(true);
  });

  it("no hero and no landscape → promotes the first item and forces landscape", () => {
    const plan = [item({ brief: "a", ratio: "portrait" }), item({ brief: "b", ratio: "square" })];
    const out = normalisePlanRoles(plan);
    expect(out[0]!.role).toBe("hero");
    expect(out[0]!.brief).toBe("a");
    expect(out[0]!.ratio).toBe("landscape");
  });

  it("two heroes → keeps the first, demotes the second to inline", () => {
    const plan = [
      item({ role: "hero", ratio: "landscape", brief: "a" }),
      item({ role: "hero", ratio: "landscape", brief: "b" }),
      item({ brief: "c" }),
    ];
    const out = normalisePlanRoles(plan);
    expect(out.filter((i) => i.role === "hero")).toHaveLength(1);
    expect(out[0]!.brief).toBe("a");
    expect(out.find((i) => i.brief === "b")!.role).toBe("inline");
  });

  it("defaults a missing/garbage role to inline before normalising", () => {
    const plan = [
      item({ brief: "a", ratio: "landscape", role: undefined as unknown as PlanItem["role"] }),
      item({ brief: "b", role: "banner" as unknown as PlanItem["role"] }),
    ];
    const out = normalisePlanRoles(plan);
    expect(out[0]!.role).toBe("hero"); // first landscape promoted
    expect(out[1]!.role).toBe("inline");
  });

  it("does not mutate its input", () => {
    const plan = [item({ brief: "a", ratio: "landscape" })];
    const before = JSON.parse(JSON.stringify(plan));
    normalisePlanRoles(plan);
    expect(plan).toEqual(before);
  });
});
