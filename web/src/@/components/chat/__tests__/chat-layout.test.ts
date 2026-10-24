import {
  FULL_MIN_WIDTH,
  STANDARD_MIN_WIDTH,
  TOOLTIP_EDGE_PX,
  TOOLTIP_GAP_PX,
  placeTooltip,
  tableTierFor,
  tierAtLeast,
} from "../chat-layout";

describe("tableTierFor", () => {
  it("draws the compact table at a phone's bubble, the standard one in the sidebar, and every column on /chat", () => {
    expect(tableTierFor(223)).toBe("compact"); // a 320px phone's bubble
    expect(tableTierFor(269)).toBe("compact"); // a 375px phone's bubble
    expect(tableTierFor(333)).toBe("standard"); // the desktop sidebar
    expect(tableTierFor(620)).toBe("full"); // the /chat page
  });

  it("changes tier exactly at the two floors", () => {
    expect(tableTierFor(STANDARD_MIN_WIDTH - 1)).toBe("compact");
    expect(tableTierFor(STANDARD_MIN_WIDTH)).toBe("standard");
    expect(tableTierFor(FULL_MIN_WIDTH - 1)).toBe("standard");
    expect(tableTierFor(FULL_MIN_WIDTH)).toBe("full");
  });

  it("draws the full table when the width is not measured", () => {
    // jsdom has no layout, and a first paint can come before the measure.
    expect(tableTierFor(0)).toBe("full");
    expect(tableTierFor(Number.NaN)).toBe("full");
  });
});

describe("tierAtLeast", () => {
  it("draws a column that starts at a tier at that tier and every wider one", () => {
    expect(tierAtLeast("compact", "standard")).toBe(false);
    expect(tierAtLeast("standard", "standard")).toBe(true);
    expect(tierAtLeast("full", "standard")).toBe(true);
    expect(tierAtLeast("full", "full")).toBe(true);
    expect(tierAtLeast("standard", "full")).toBe(false);
  });

  it("draws a column with no starting tier at every width", () => {
    expect(tierAtLeast("compact")).toBe(true);
  });
});

describe("placeTooltip", () => {
  const viewport = { width: 320, height: 600 };
  const size = { width: 200, height: 40 };

  it("sits above its reading on the reading's trailing edge when there is room", () => {
    const placed = placeTooltip({ left: 60, top: 300, right: 156, bottom: 328 }, size, viewport);
    expect(placed.placement).toBe("above");
    expect(placed.top).toBe(300 - TOOLTIP_GAP_PX - 40);
  });

  it("opens below a reading in the first row, which has no room above it", () => {
    // The reading sits 20px from the top, under the sticky header: 20 - 6 - 40 is off the top.
    const placed = placeTooltip({ left: 200, top: 20, right: 296, bottom: 48 }, size, viewport);
    expect(placed.placement).toBe("below");
    expect(placed.top).toBe(48 + TOOLTIP_GAP_PX);
  });

  it("holds a tooltip inside the right edge for a reading in the last column", () => {
    const placed = placeTooltip({ left: 222, top: 300, right: 318, bottom: 328 }, size, viewport);
    expect(placed.left + size.width).toBeLessThanOrEqual(viewport.width - TOOLTIP_EDGE_PX);
    expect(placed.left).toBe(viewport.width - size.width - TOOLTIP_EDGE_PX);
  });

  it("holds a tooltip inside the left edge when its trailing edge would run off it", () => {
    const placed = placeTooltip({ left: 0, top: 300, right: 40, bottom: 328 }, size, viewport);
    expect(placed.left).toBe(TOOLTIP_EDGE_PX);
  });

  it("keeps a tooltip inside the bottom when the reading is last and nothing fits", () => {
    const short = { width: 200, height: 580 };
    const placed = placeTooltip({ left: 60, top: 300, right: 156, bottom: 328 }, short, viewport);
    expect(placed.top).toBeGreaterThanOrEqual(TOOLTIP_EDGE_PX);
    expect(placed.top + short.height).toBeLessThanOrEqual(viewport.height - TOOLTIP_EDGE_PX);
  });

  it("gives the left edge when a tooltip is wider than the window", () => {
    const wide = { width: 400, height: 40 };
    const placed = placeTooltip({ left: 10, top: 300, right: 60, bottom: 328 }, wide, viewport);
    expect(placed.left).toBe(TOOLTIP_EDGE_PX);
  });
});
