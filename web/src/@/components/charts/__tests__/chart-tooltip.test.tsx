import { act, render, renderHook } from "@testing-library/react";
import { scaleTime } from "@visx/scale";
import { TooltipContent, stepIndex, useChartPointer } from "../chart-tooltip";
import type { ChartSeriesSpec } from "../types";

// localPoint needs real SVG geometry; jsdom has none. Read client coords as-is.
jest.mock("@visx/event", () => ({
  localPoint: (e: { clientX?: number; clientY?: number }) =>
    e.clientX == null ? null : { x: e.clientX, y: e.clientY ?? 0 },
}));

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);
const MARGIN_LEFT = 40;
const INNER_W = 900; // 10 points -> 100px apart

const mkSeries = (id: string, axis: "left" | "right", base: number): ChartSeriesSpec => ({
  id,
  label: id,
  color: "#000",
  axis,
  kind: "line",
  points: Array.from({ length: 10 }, (_, i) => ({ t: T0 + i * DAY, v: base + i })),
});

const series = [mkSeries("price", "left", 10), mkSeries("short", "right", 2)];
const xScale = scaleTime<number>({
  domain: [new Date(T0), new Date(T0 + 9 * DAY)],
  range: [0, INNER_W],
});

// A minimal React mouse event shape: localPoint (mocked) only reads clientX/Y.
const moveAt = (innerX: number, y = 50) =>
  ({ clientX: innerX + MARGIN_LEFT, clientY: y }) as unknown as React.MouseEvent<SVGElement>;

function setup(s: ChartSeriesSpec[] = series) {
  return renderHook(
    ({ ser }) => useChartPointer({ xScale, series: ser, marginLeft: MARGIN_LEFT }),
    { initialProps: { ser: s } },
  );
}

describe("useChartPointer", () => {
  it("onMove sets hover to the nearest point of every series", () => {
    const { result } = setup();
    act(() => {
      result.current.onMove(moveAt(310));
    });
    const h = result.current.hover!;
    expect(h).not.toBeNull();
    expect(h.cx).toBeCloseTo(300);
    expect(h.cy).toBe(50);
    expect(h.source).toBe("mouse");
    expect(h.entries.map((e) => [e.series.id, e.point.v])).toEqual([
      ["price", 13],
      ["short", 5],
    ]);
    expect(result.current.active).toBe(h);
    expect(result.current.isPinnedView).toBe(false);
  });

  it("onLeave clears hover but never the pin", () => {
    const { result } = setup();
    act(() => {
      result.current.onMove(moveAt(300));
    });
    act(() => result.current.pin());
    act(() => result.current.onMove(moveAt(600)));
    act(() => result.current.onLeave());
    expect(result.current.hover).toBeNull();
    expect(result.current.pinned).not.toBeNull();
    expect(result.current.pinned!.cx).toBeCloseTo(300);
  });

  it("pin then onLeave keeps `active` on the pinned reading", () => {
    const { result } = setup();
    act(() => {
      result.current.onMove(moveAt(200));
    });
    act(() => result.current.pin());
    act(() => result.current.onLeave());
    expect(result.current.active).not.toBeNull();
    expect(result.current.active!.entries[0]!.point.t).toBe(T0 + 2 * DAY);
    expect(result.current.isPinnedView).toBe(true);
  });

  it("a live hover takes precedence over the pin", () => {
    const { result } = setup();
    act(() => result.current.togglePinAt(100));
    act(() => {
      result.current.onMove(moveAt(700));
    });
    expect(result.current.active!.cx).toBeCloseTo(700);
    expect(result.current.isPinnedView).toBe(false);
    act(() => result.current.onLeave());
    expect(result.current.active!.cx).toBeCloseTo(100);
  });

  it("togglePinAt pins, moves, and releases within tolerance", () => {
    const { result } = setup();
    act(() => result.current.togglePinAt(400));
    expect(result.current.pinned!.cx).toBeCloseTo(400);
    // Far away: the pin moves.
    act(() => result.current.togglePinAt(800));
    expect(result.current.pinned!.cx).toBeCloseTo(800);
    // Same point again (snaps to the same x): releases.
    act(() => result.current.togglePinAt(805));
    expect(result.current.pinned).toBeNull();
  });

  it("unpin clears the pin", () => {
    const { result } = setup();
    act(() => result.current.togglePinAt(400));
    act(() => result.current.unpin());
    expect(result.current.pinned).toBeNull();
    expect(result.current.active).toBeNull();
  });

  it("pin without a hover is a no-op", () => {
    const { result } = setup();
    act(() => result.current.pin());
    expect(result.current.pinned).toBeNull();
  });

  it("drops the pin when the series identity changes", () => {
    const { result, rerender } = setup();
    act(() => result.current.togglePinAt(400));
    expect(result.current.pinned).not.toBeNull();
    // Same data, new array identity: the pin survives.
    rerender({ ser: series.map((s) => ({ ...s })) });
    expect(result.current.pinned).not.toBeNull();
    // Different series id (e.g. a view switch): the pin goes.
    rerender({ ser: [mkSeries("other", "left", 1)] });
    expect(result.current.pinned).toBeNull();
  });

  describe("pinAtTime", () => {
    it("pins the nearest point of every series to a time, with no pointer", () => {
      const { result } = setup();
      act(() => result.current.pinAtTime(T0 + 3 * DAY + 1000));
      const p = result.current.pinned!;
      expect(p.source).toBe("keyboard");
      expect(p.t).toBe(T0 + 3 * DAY + 1000);
      expect(p.cx).toBeCloseTo(300);
      expect(p.entries.map((e) => [e.series.id, e.point.v])).toEqual([
        ["price", 13],
        ["short", 5],
      ]);
      expect(result.current.isPinnedView).toBe(true);
      expect(result.current.hover).toBeNull();
    });

    it("moves an existing pin, and a live hover still takes precedence", () => {
      const { result } = setup();
      act(() => result.current.pinAtTime(T0 + 3 * DAY));
      act(() => result.current.pinAtTime(T0 + 6 * DAY));
      expect(result.current.pinned!.entries[0]!.point.v).toBe(16);
      act(() => {
        result.current.onMove(moveAt(100));
      });
      expect(result.current.isPinnedView).toBe(false);
      act(() => result.current.onLeave());
      expect(result.current.pinned!.entries[0]!.point.v).toBe(16);
    });

    it("is dropped, like any pin, when the series changes", () => {
      const { result, rerender } = setup();
      act(() => result.current.pinAtTime(T0 + 3 * DAY));
      rerender({ ser: [mkSeries("other", "left", 1)] });
      expect(result.current.pinned).toBeNull();
    });

    it("does nothing when no series has a point", () => {
      const { result } = setup([{ ...mkSeries("empty", "left", 1), points: [] }]);
      act(() => result.current.pinAtTime(T0));
      expect(result.current.pinned).toBeNull();
    });
  });

  describe("hoverAtX", () => {
    it("shows the hover reading at an inner x, with no event to read it from", () => {
      const { result } = setup();
      act(() => result.current.hoverAtX(310, 77));
      const h = result.current.hover!;
      expect(h).not.toBeNull();
      expect(h.cx).toBeCloseTo(300); // snapped to the nearest point's x
      expect(h.cy).toBe(77);
      expect(h.source).toBe("mouse");
      expect(h.entries.map((e) => [e.series.id, e.point.v])).toEqual([
        ["price", 13],
        ["short", 5],
      ]);
      expect(result.current.active).toBe(h);
      expect(result.current.isPinnedView).toBe(false);
    });

    it("reads what a move to the same x reads", () => {
      const moved = setup();
      act(() => {
        moved.result.current.onMove(moveAt(520, 31));
      });
      const placed = setup();
      act(() => placed.result.current.hoverAtX(520, 31));
      expect(placed.result.current.hover).toEqual(moved.result.current.hover);
    });

    it("is a live hover: it outranks a pin, and onLeave clears it", () => {
      const { result } = setup();
      act(() => result.current.togglePinAt(100));
      act(() => result.current.hoverAtX(700, 0));
      expect(result.current.isPinnedView).toBe(false);
      expect(result.current.active!.cx).toBeCloseTo(700);
      act(() => result.current.onLeave());
      expect(result.current.hover).toBeNull();
      expect(result.current.active!.cx).toBeCloseTo(100);
    });

    it("moves an earlier hover rather than adding to it", () => {
      const { result } = setup();
      act(() => result.current.hoverAtX(100, 0));
      act(() => result.current.hoverAtX(800, 0));
      expect(result.current.hover!.cx).toBeCloseTo(800);
    });

    it("shows nothing when no series has a point", () => {
      const { result } = setup([{ ...mkSeries("empty", "left", 1), points: [] }]);
      act(() => result.current.hoverAtX(300, 0));
      expect(result.current.hover).toBeNull();
    });
  });
});

describe("TooltipContent", () => {
  /**
   * A hover with one entry whose point is at `pointT` and the cursor at
   * `cursorT` (by default the same instant). The card dates the reading by the
   * point it shows: a cursor between two sessions has no date of its own, so the
   * time a test expects to read goes on the point.
   */
  const hoverOn = (pointT: number, cursorT: number = pointT) => ({
    cx: 0,
    cy: 0,
    t: cursorT,
    entries: [{ series: series[0]!, point: { t: pointT, v: 10 } }],
  });

  it("dates the reading en-AU on the Sydney calendar", () => {
    // 20:00 UTC on 1 January is 07:00 on 2 January in Sydney (UTC+11).
    const { container } = render(
      <TooltipContent hover={hoverOn(Date.UTC(2026, 0, 1, 20, 0))} />,
    );
    expect(container.textContent).toContain("2 Jan 2026");
  });

  it("does not take the date from the browser's locale", () => {
    // This environment's own locale is en-AU, so stub the API that follows the
    // browser's: the card used to print its date through it.
    const browserLocale = jest
      .spyOn(Date.prototype, "toLocaleDateString")
      .mockReturnValue("BROWSER-LOCALE-DATE");
    try {
      const { container } = render(<TooltipContent hover={hoverOn(T0)} />);
      expect(container.textContent).not.toContain("BROWSER-LOCALE-DATE");
      expect(container.textContent).toContain("1 Jan 2026");
    } finally {
      browserLocale.mockRestore();
    }
  });

  it("dates the reading by its data point, not by where the cursor is", () => {
    // The point is Friday 2 January (11:00 Sydney). The cursor is 12 hours past
    // Saturday's UTC midnight, which is 23:00 on Saturday 3 January in Sydney:
    // a day the ASX did not trade, and not the one the card shows a price for.
    const friday = T0 + DAY;
    const saturday = T0 + 2.5 * DAY;
    const { container } = render(<TooltipContent hover={hoverOn(friday, saturday)} />);
    expect(container.textContent).toContain("2 Jan 2026");
    expect(container.textContent).not.toContain("3 Jan 2026");
  });

  it("dates the reading by its first entry's point when the entries are on different days", () => {
    // The short series lags the price by days; the card is headed by the first.
    // The cursor is on the 5th in Sydney (03:48), the first point on the 4th.
    const lagging = { series: series[1]!, point: { t: T0 - 4 * DAY, v: 2 } };
    const hover = hoverOn(T0 + 3 * DAY, T0 + 3.7 * DAY);
    const { container } = render(
      <TooltipContent hover={{ ...hover, entries: [...hover.entries, lagging] }} />,
    );
    expect(container.textContent).toContain("4 Jan 2026");
    expect(container.textContent).not.toContain("5 Jan 2026");
    expect(container.textContent).not.toContain("28 Dec 2025");
  });

  it("falls back to the cursor's time when there is no entry to date it by", () => {
    const { container } = render(
      <TooltipContent hover={{ cx: 0, cy: 0, t: T0 + 5 * DAY, entries: [] }} />,
    );
    expect(container.textContent).toContain("6 Jan 2026");
  });

  it("names the session's volume in full, last, when it is given one", () => {
    const { container } = render(
      <TooltipContent hover={hoverOn(T0)} volume={{ value: "1.2M", dateNote: null }} />,
    );
    const row = container.querySelector("[data-tooltip-volume]")!;
    expect(row.textContent).toBe("Volume1.2M");
    expect(row.getAttribute("title")).toMatch(/shares traded/i);
    expect(row.parentElement!.lastElementChild).toBe(row);
  });

  it("has no volume row when the chart draws no volume", () => {
    const { container } = render(<TooltipContent hover={hoverOn(T0)} />);
    expect(container.querySelector("[data-tooltip-volume]")).toBeNull();
  });
});

describe("stepIndex", () => {
  const pts = Array.from({ length: 5 }, (_, i) => ({ t: T0 + i * DAY, v: i }));

  it("jumps to the ends on Home and End", () => {
    expect(stepIndex(pts, "Home", null)).toBe(0);
    expect(stepIndex(pts, "Home", T0 + 3 * DAY)).toBe(0);
    expect(stepIndex(pts, "End", null)).toBe(4);
    expect(stepIndex(pts, "End", T0 + DAY)).toBe(4);
  });

  it("starts from the last point while nothing is pinned", () => {
    expect(stepIndex(pts, "ArrowLeft", null)).toBe(3);
    expect(stepIndex(pts, "ArrowRight", null)).toBe(4); // there is no next
  });

  it("moves one point from the one nearest the pinned time", () => {
    expect(stepIndex(pts, "ArrowLeft", T0 + 2 * DAY)).toBe(1);
    expect(stepIndex(pts, "ArrowRight", T0 + 2 * DAY)).toBe(3);
    // A pointer-made pin sits between points: it counts as the nearer one.
    expect(stepIndex(pts, "ArrowRight", T0 + 2.4 * DAY)).toBe(3);
    expect(stepIndex(pts, "ArrowLeft", T0 + 2.6 * DAY)).toBe(2);
  });

  it("stops at the ends", () => {
    expect(stepIndex(pts, "ArrowLeft", T0)).toBe(0);
    expect(stepIndex(pts, "ArrowRight", T0 + 4 * DAY)).toBe(4);
    expect(stepIndex([pts[0]!], "ArrowLeft", null)).toBe(0);
  });

  it("answers null for a key that does not step, and for no points", () => {
    expect(stepIndex(pts, "Enter", null)).toBeNull();
    expect(stepIndex(pts, "ArrowUp", null)).toBeNull();
    expect(stepIndex([], "Home", null)).toBeNull();
    expect(stepIndex([], "ArrowLeft", T0)).toBeNull();
  });
});
