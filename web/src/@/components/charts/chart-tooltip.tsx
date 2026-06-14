import React, { useCallback, useMemo, useState } from "react";
import { localPoint } from "@visx/event";
import { bisector } from "@visx/vendor/d3-array";
import { chartTheme } from "./chart-theme";
import type { ChartPoint, ChartSeriesSpec, AxisSpec } from "./types";
import type { ChartScales } from "./use-chart-scales";

const tBisector = bisector<ChartPoint, number>((d) => d.t);

function nearest(points: ChartPoint[], t: number): ChartPoint | null {
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
  cx: number; // crosshair x (px, inner coords)
  t: number; // hovered time
  entries: HoverEntry[];
}

/**
 * Pointer-driven hover. On move it inverts x → time once and bisects each
 * (already decimated, small) series for its nearest point. No scale rebuilding.
 */
export function useChartPointer(opts: {
  xScale: ChartScales["dateScale"];
  series: ChartSeriesSpec[];
  marginLeft: number;
}) {
  const { xScale, series, marginLeft } = opts;
  const [hover, setHover] = useState<HoverState | null>(null);

  const onMove = useCallback(
    (
      e:
        | React.MouseEvent<SVGElement>
        | React.TouchEvent<SVGElement>,
    ) => {
      const pt = localPoint(e);
      if (!pt) return;
      const innerX = pt.x - marginLeft;
      const t = xScale.invert(innerX).getTime();
      const entries: HoverEntry[] = [];
      for (const s of series) {
        const p = nearest(s.points, t);
        if (p) entries.push({ series: s, point: p });
      }
      if (!entries.length) {
        setHover(null);
        return;
      }
      const cx = xScale(new Date(entries[0]!.point.t)) ?? innerX;
      setHover({ cx, t, entries });
    },
    [xScale, series, marginLeft],
  );

  const onLeave = useCallback(() => setHover(null), []);

  return { hover, onMove, onLeave };
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
