import {
  FULL_MIN_WIDTH,
  STANDARD_MIN_WIDTH,
  TOOLTIP_EDGE_PX,
  TOOLTIP_GAP_PX,
  lineCrossesBox,
  placeLatestLabel,
  placeTooltip,
  readingIsInView,
  rectsOverlap,
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

describe("lineCrossesBox", () => {
  const box = { left: 40, right: 80, top: 20, bottom: 30 };

  it("sees a line that runs through the box", () => {
    const line = [
      { x: 0, y: 25 },
      { x: 100, y: 25 },
    ];
    expect(lineCrossesBox(line, box)).toBe(true);
  });

  it("sees a line that passes over the box, and one beside it", () => {
    expect(lineCrossesBox([{ x: 0, y: 5 }, { x: 100, y: 5 }], box)).toBe(false);
    expect(lineCrossesBox([{ x: 0, y: 50 }, { x: 100, y: 50 }], box)).toBe(false);
  });

  it("sees a peak between two readings, whose ends are both outside the box", () => {
    // Neither reading is in the box's x-span, but the segment between them crosses it.
    const peak = [
      { x: 0, y: 60 },
      { x: 40, y: 0 },
      { x: 100, y: 60 },
    ];
    expect(lineCrossesBox(peak, box)).toBe(true);
  });

  it("sees a single point inside the box", () => {
    expect(lineCrossesBox([{ x: 50, y: 25 }], box)).toBe(true);
    expect(lineCrossesBox([{ x: 90, y: 25 }], box)).toBe(false);
  });
});

describe("placeLatestLabel", () => {
  // A plot 140px tall. The latest reading is at the right edge, 60px down.
  const plotHeight = 140;
  const latest = { x: 250, y: 60 };

  it("sits above a reading the line does not come up to", () => {
    const flat = [
      { x: 0, y: 60 },
      { x: 125, y: 60 },
      { x: 250, y: 60 },
    ];
    const placed = placeLatestLabel({ line: flat, latest, text: "7.00%", plotHeight });
    expect(placed).toEqual({ x: 250, y: 60 - 7, placement: "above" });
  });

  it("flips below a reading when the series peaks just before it, so the peak is not hidden", () => {
    // The peak is a few readings back and above the label's space: the line runs through it.
    const peak = [
      { x: 0, y: 60 },
      { x: 200, y: 10 },
      { x: 240, y: 12 },
      { x: 250, y: 60 },
    ];
    const placed = placeLatestLabel({ line: peak, latest, text: "15.93%", plotHeight });
    expect(placed.placement).toBe("below");
    expect(placed.y).toBeGreaterThan(latest.y);
  });

  it("moves the label into the band over the plot when the line runs past the reading on both sides", () => {
    // A series rising into the reading from below, then peaking just before it (a real DRO
    // answer): the line is crossed above the reading and below it too.
    const rising = [
      { x: 230, y: 130 },
      { x: 240, y: 25 },
      { x: 250, y: 60 },
    ];
    const placed = placeLatestLabel({ line: rising, latest: { x: 250, y: 60 }, text: "15.93%", plotHeight });
    expect(placed.placement).toBe("top");
    // The band sits above the plot, where no value can reach.
    expect(placed.y).toBeLessThan(0);
    expect(placed.y).toBeGreaterThan(-16);
  });

  it("flips a reading at the plot's foot into the bottom margin, which has room for the label", () => {
    const peak = [
      { x: 0, y: 100 },
      { x: 200, y: 10 },
      { x: 250, y: 139 },
    ];
    const placed = placeLatestLabel({
      line: peak,
      latest: { x: 250, y: 139 },
      text: "15.93%",
      plotHeight,
    });
    // The chart's bottom margin is 22px. The label's descent must land inside it.
    expect(placed.placement).toBe("below");
    expect(placed.y + 2).toBeLessThanOrEqual(plotHeight + 22);
  });

  it("holds the label's start at the plot's left edge when the label is wider than the plot", () => {
    const placed = placeLatestLabel({
      line: [
        { x: 0, y: 60 },
        { x: 30, y: 60 },
      ],
      latest: { x: 30, y: 60 },
      text: "US$78.25 per barrel",
      plotHeight,
    });
    // The text is 19 characters at 7px: its start must not be left of x = 0.
    expect(placed.x - "US$78.25 per barrel".length * 7).toBeGreaterThanOrEqual(0);
  });
});

describe("readingIsInView", () => {
  const region = { left: 0, top: 100, right: 300, bottom: 400 };
  const viewport = { left: 0, top: 0, right: 375, bottom: 800 };

  it("is in view while the reading overlaps every clip", () => {
    const reading = { left: 50, top: 150, right: 60, bottom: 170 };
    expect(readingIsInView(reading, [viewport, region])).toBe(true);
  });

  it("is out of view once it has scrolled above the region that clips it", () => {
    const scrolled = { left: 50, top: 60, right: 60, bottom: 80 };
    expect(readingIsInView(scrolled, [viewport, region])).toBe(false);
  });

  it("is out of view when it is off the window", () => {
    const offscreen = { left: 50, top: 850, right: 60, bottom: 870 };
    expect(readingIsInView(offscreen, [viewport])).toBe(false);
  });

  it("treats a reading with no layout as in view, since nothing says it is not", () => {
    expect(readingIsInView({ left: 0, top: 0, right: 0, bottom: 0 }, [region])).toBe(true);
  });

  it("does not count a reading that only touches a clip's edge", () => {
    const touching = { left: 50, top: 80, right: 60, bottom: 100 };
    expect(rectsOverlap(touching, region)).toBe(false);
  });
});
