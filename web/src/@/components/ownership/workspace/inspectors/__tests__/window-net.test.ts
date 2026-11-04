/// <reference types="jest" />

import { changePpOf, windowNetText } from "../window-net";

describe("window net change (spec 14.1, backlog C1)", () => {
  it("reads a row's change in points only when it is a finite number", () => {
    expect(changePpOf({ changePp: 1.25 })).toBe(1.25);
    expect(changePpOf({ changePp: null })).toBeNull();
    expect(changePpOf({ changePp: Number.NaN })).toBeNull();
    expect(changePpOf({ changePp: "1.25" })).toBeNull();
    expect(changePpOf({})).toBeNull();
  });

  it("sums every notice of a whole window with its sign, printed with the true minus", () => {
    expect(windowNetText([{ changePp: 2 }, { changePp: -0.5 }, { changePp: -0.25 }], 3)).toBe("+1.25 pp");
    expect(windowNetText([{ changePp: -1 }, { changePp: -0.5 }], 2)).toBe("−1.50 pp");
  });

  it("has no net for an empty window, a partial page, or a window with one row that states no change", () => {
    expect(windowNetText([], 0)).toBeUndefined();
    expect(windowNetText([{ changePp: 1 }], 2)).toBeUndefined();
    expect(windowNetText([{ changePp: 1 }, {}], 2)).toBeUndefined();
    expect(windowNetText([{ changePp: 1 }, { changePp: null }], 2)).toBeUndefined();
  });
});
