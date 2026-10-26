import { describe, expect, it } from "@jest/globals";
import { shortPercentFigure, statedShortPercent } from "../short-percent";

// ANT: 164 shares short of about 800 million on issue.
const ANT = 164 / 800_000_000 * 100;

describe("statedShortPercent", () => {
  it.each([
    [9.4215, 2, "9.42"],
    [0.005, 2, "0.01"],
    [0.03, 2, "0.03"],
    [9.4215, 1, "9.4"],
    [0.05, 1, "0.1"],
  ])("states %p to %p digits as %p", (value, digits, stated) => {
    expect(statedShortPercent(value, digits)).toBe(stated);
  });

  it.each([
    ["a position that rounds to zero", ANT, 2],
    ["one that rounds to zero at one digit", 0.03, 1],
    ["zero", 0, 2],
    ["absent", undefined, 2],
    ["negative", -1.2, 2],
    ["not a number", Number.NaN, 2],
    ["infinite", Number.POSITIVE_INFINITY, 2],
  ])("states no level for %s", (_name, value, digits) => {
    expect(statedShortPercent(value, digits)).toBeNull();
  });
});

describe("shortPercentFigure", () => {
  it("shows a stated level with its sign", () => {
    expect(shortPercentFigure(9.4215)).toBe("9.42%");
    expect(shortPercentFigure(9.4215, 1)).toBe("9.4%");
  });

  it("shows the bound, never a zero, for a position too small to state", () => {
    expect(shortPercentFigure(ANT)).toBe("<0.01%");
    expect(shortPercentFigure(0.03, 1)).toBe("<0.1%");
    expect(shortPercentFigure(0.03)).toBe("0.03%");
  });

  it.each([0, undefined, -1.2, Number.NaN, Number.POSITIVE_INFINITY])(
    "shows nothing for no position (%p)",
    (value) => {
      expect(shortPercentFigure(value)).toBeNull();
    },
  );
});
