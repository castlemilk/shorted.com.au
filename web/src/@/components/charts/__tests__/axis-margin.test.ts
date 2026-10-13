import {
  AXIS_CHAR_PX,
  AXIS_LABEL_DX_PX,
  AXIS_MIN_MARGIN_PX,
  AXIS_TICK_PX,
  axisMargin,
} from "../axis-margin";

// What an axis has to fit into the margin beside the plot: the tick, the
// label's own offset from it, then the label. The svg clips the rest.
const BEFORE_LABEL = AXIS_TICK_PX + AXIS_LABEL_DX_PX;

describe("axisMargin", () => {
  it("keeps the 48px floor for an axis with nothing to print", () => {
    expect(axisMargin([])).toBe(AXIS_MIN_MARGIN_PX);
    expect(axisMargin([""])).toBe(AXIS_MIN_MARGIN_PX);
  });

  it("keeps it for the labels a stock under $100 or a short position prints: six characters at most", () => {
    // "$40.00", "$99.99" and "12.00%" are six characters: 37px by this
    // estimate and the 10px before them, which is 47 and so under the floor.
    expect(axisMargin(["$40.00", "$45.00"])).toBe(48);
    expect(axisMargin(["$99.99"])).toBe(48);
    expect(axisMargin(["12.00%", "0.00%"])).toBe(48);
    expect(axisMargin(["$5.00"])).toBe(48);
  });

  it("grows by a character's width for a seventh: '$140.00' is 43px and the 10px before it", () => {
    expect(axisMargin(["$140.00"])).toBe(Math.ceil(7 * AXIS_CHAR_PX) + BEFORE_LABEL);
    expect(axisMargin(["$140.00"])).toBe(53);
    expect(axisMargin(["$140.00", "$190.00"])).toBe(53);
  });

  it("follows the widest label, wherever it falls among the ticks", () => {
    expect(axisMargin(["$98.00", "$100.00", "$102.00"])).toBe(53);
    expect(axisMargin(["$140.00", "$40.00"])).toBe(53);
    expect(axisMargin(["$1,234.56", "$1,300.00"])).toBe(Math.ceil(9 * AXIS_CHAR_PX) + BEFORE_LABEL);
    expect(axisMargin(["$1,234.56"])).toBe(65);
  });

  it("counts a signed label by its characters: the sign takes a character's room", () => {
    // "+123.4%" and the true minus "−123.4%" are both seven.
    expect(axisMargin(["+123.4%"])).toBe(53);
    expect(axisMargin(["−123.4%", "0.0%"])).toBe(53);
    expect(axisMargin(["+12.3%"])).toBe(48);
  });

  it("is wide enough that a label never reaches past the svg, at the face's real advance", () => {
    // IBM Plex Mono, like the other mono faces the stack falls back to, sets
    // 0.6em a character: 6px at 10px. The estimate is a little over that.
    expect(AXIS_CHAR_PX).toBeGreaterThanOrEqual(6);
    for (let chars = 1; chars <= 14; chars++) {
      expect(axisMargin(["9".repeat(chars)])).toBeGreaterThanOrEqual(BEFORE_LABEL + chars * 6);
    }
  });

  it("is a whole number of pixels", () => {
    for (const label of ["$1.00", "$140.00", "$1,234.56", "+1,234.5%"]) {
      expect(Number.isInteger(axisMargin([label]))).toBe(true);
    }
  });
});
