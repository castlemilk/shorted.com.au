import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { localPoint } from "@visx/event";
import { bisector } from "@visx/vendor/d3-array";
import { chartTheme } from "./chart-theme";
import type { ChartPoint, ChartSeriesSpec, AxisSpec } from "./types";
import type { ChartScales } from "./use-chart-scales";

const tBisector = bisector<ChartPoint, number>((d) => d.t);

/** Nearest data point to time `t` (binary search; points must be sorted by t). */
export function nearest(points: ChartPoint[], t: number): ChartPoint | null {
  if (!points.length) return null;
  const i = tBisector.left(points, t, 1);
  const a = points[i - 1];
  const b = points[i];
  if (!a) return b ?? null;
  if (!b) return a;
  return t - a.t < b.t - t ? a : b;
}

export interface HoverEntry {
  series: ChartSeriesSpec;
  point: ChartPoint;
}
export interface HoverState {
  cx: number; // crosshair x (px, inner-plot coordinates)
  cy: number; // cursor y (px, relative to the svg/container) — tooltip follows it
  t: number; // hovered time
  entries: HoverEntry[];
  /** Input that produced this hover. Touch hovers dock the tooltip in a corner. */
  source?: "mouse" | "touch";
}

/** A re-tap within this many px of the pinned crosshair releases the pin. */
export const PIN_TOLERANCE_PX = 10;

type PointerEvt = React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>;

const isTouchEvent = (e: PointerEvt): e is React.TouchEvent<SVGElement> =>
  "touches" in e;

/**
 * Identity of the rendered data: ids + first/last time + first value per
 * series. A pin is only meaningful against the data it was taken from, so a
 * period/view/zoom change (any of which moves one of these) drops it.
 */
function seriesIdentity(series: ChartSeriesSpec[]): string {
  return series
    .map((s) => {
      const a = s.points[0];
      const b = s.points[s.points.length - 1];
      return `${s.id}:${a?.t ?? ""}:${b?.t ?? ""}:${a?.v ?? ""}`;
    })
    .join("|");
}

/**
 * Pointer-driven hover plus a touch "pin". On move it inverts x → time once and
 * bisects each (already decimated, small) series for its nearest point. No
 * scale rebuilding.
 *
 * `hover` is the live pointer reading (cleared by `onLeave`). `pinned` is a
 * reading a touch user locked by lifting their finger; it survives
 * mouse-leave/touch-end and is cleared only by `unpin` / `togglePinAt` or a
 * change of the underlying series. Render `active` (= hover ?? pinned): a live
 * mouse hover takes precedence and the pin returns when the mouse leaves.
 */
export function useChartPointer(opts: {
  xScale: ChartScales["dateScale"];
  series: ChartSeriesSpec[];
  marginLeft: number;
}) {
  const { xScale, series, marginLeft } = opts;
  const [hover, setHoverState] = useState<HoverState | null>(null);
  // Mirror for handlers that must read the latest hover synchronously (a
  // touchend pins whatever the preceding touchmove set in the same tick).
  const hoverRef = useRef<HoverState | null>(null);
  const setHover = useCallback((h: HoverState | null) => {
    hoverRef.current = h;
    setHoverState(h);
  }, []);

  const key = useMemo(() => seriesIdentity(series), [series]);
  const [pinState, setPinState] = useState<{ h: HoverState; key: string } | null>(
    null,
  );

  // Drop a pin taken against data that is no longer on screen.
  useEffect(() => {
    setPinState((p) => (p && p.key !== key ? null : p));
  }, [key]);

  /** Hover reading at an inner-plot x (px). Null when no series has a point. */
  const hoverAt = useCallback(
    (innerX: number, cy: number, source: "mouse" | "touch" = "mouse") => {
      const t = xScale.invert(innerX).getTime();
      const entries: HoverEntry[] = [];
      for (const s of series) {
        const p = nearest(s.points, t);
        if (p) entries.push({ series: s, point: p });
      }
      if (!entries.length) return null;
      const cx = xScale(new Date(entries[0]!.point.t)) ?? innerX;
      const h: HoverState = { cx, cy, t, entries, source };
      return h;
    },
    [xScale, series],
  );

  const onMove = useCallback(
    (e: PointerEvt): HoverState | null => {
      const pt = localPoint(e);
      if (!pt) return null;
      const h = hoverAt(
        pt.x - marginLeft,
        pt.y,
        isTouchEvent(e) ? "touch" : "mouse",
      );
      setHover(h);
      return h;
    },
    [hoverAt, marginLeft, setHover],
  );

  const onLeave = useCallback(() => setHover(null), [setHover]);

  // The pin as rendered NOW: crosshair x re-derived from the live scale so a
  // resize keeps it on its data point. Stale-key pins never render (the effect
  // above clears them a commit later).
  const pinned = useMemo<HoverState | null>(() => {
    if (!pinState || pinState.key !== key) return null;
    const h = pinState.h;
    const first = h.entries[0];
    const cx = first ? (xScale(new Date(first.point.t)) ?? h.cx) : h.cx;
    return { ...h, cx };
  }, [pinState, key, xScale]);

  /** Pin `h`, or the current hover when omitted. No-op without either. */
  const pin = useCallback(
    (h?: HoverState | null) => {
      const target = h ?? hoverRef.current;
      if (!target) return;
      setPinState({ h: target, key });
    },
    [key],
  );

  const unpin = useCallback(() => setPinState(null), []);

  /**
   * Toggle a pin at an inner-plot x (or a ready hover reading): within
   * PIN_TOLERANCE_PX of the current pin releases it, anywhere else moves it.
   */
  const togglePinAt = useCallback(
    (at: number | HoverState) => {
      const h = typeof at === "number" ? hoverAt(at, 0, "touch") : at;
      if (!h) return;
      if (pinned && Math.abs(pinned.cx - h.cx) <= PIN_TOLERANCE_PX) {
        setPinState(null);
      } else {
        setPinState({ h, key });
      }
    },
    [hoverAt, pinned, key],
  );

  const active = hover ?? pinned;

  return {
    hover,
    pinned,
    active,
    /** True when what is rendered comes from the pin, not a live pointer. */
    isPinnedView: !hover && !!pinned,
    onMove,
    onLeave,
    pin,
    unpin,
    togglePinAt,
  };
}

/** Tooltip body: one row per series, value formatted by its axis. */
export function TooltipContent({
  hover,
  leftAxis,
  rightAxis,
}: {
  hover: HoverState;
  leftAxis?: AxisSpec;
  rightAxis?: AxisSpec;
}) {
  const dateLabel = useMemo(
    () =>
      new Date(hover.t).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    [hover.t],
  );
  const fmt = (e: HoverEntry) => {
    const f =
      e.series.axis === "right" ? rightAxis?.format : leftAxis?.format;
    return f ? f(e.point.v) : e.point.v.toFixed(2);
  };
  return (
    <div style={{ color: chartTheme.tooltipFg, fontSize: 12, lineHeight: 1.4 }}>
      <div style={{ opacity: 0.7, marginBottom: 4 }}>{dateLabel}</div>
      {hover.entries.map((e) => {
        const p = e.point;
        const hasOHLC =
          p.open != null && p.high != null && p.low != null && p.close != null;
        return (
          <div key={e.series.id} style={{ marginBottom: 2 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 9999,
                  background: e.series.color,
                  display: "inline-block",
                }}
              />
              <span style={{ opacity: 0.8 }}>{e.series.label}</span>
              <span style={{ marginLeft: "auto", fontVariantNumeric: "tabular-nums" }}>
                {fmt(e)}
              </span>
            </div>
            {hasOHLC && (
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: "0 10px",
                  paddingLeft: 14,
                  marginTop: 2,
                  opacity: 0.65,
                  fontSize: 11,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span>O {p.open!.toFixed(2)}</span>
                <span>H {p.high!.toFixed(2)}</span>
                <span>L {p.low!.toFixed(2)}</span>
                <span>C {p.close!.toFixed(2)}</span>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
