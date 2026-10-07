import { act, renderHook } from "@testing-library/react";
import { scaleTime } from "@visx/scale";
import { useChartPointer } from "../chart-tooltip";
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
});
