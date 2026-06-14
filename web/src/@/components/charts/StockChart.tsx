"use client";

import React, {
  forwardRef,
  useCallback,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { ParentSize } from "@visx/responsive";
import { Group } from "@visx/group";
import { scaleLinear, scaleTime } from "@visx/scale";
import { Brush } from "@visx/brush";
import type BaseBrush from "@visx/brush/lib/BaseBrush";
import type { Bounds } from "@visx/brush/lib/types";
import { Line, AreaClosed } from "@visx/shape";
import { curveMonotoneX } from "@visx/curve";
import { useTooltipInPortal } from "@visx/tooltip";
import { decimate } from "./decimate";
import { useChartScales } from "./use-chart-scales";
import { normalizeToPercentChange } from "./indicators";
import { chartTheme } from "./chart-theme";
import {
  Axes,
  Crosshair,
  Grid,
  IndicatorPath,
  SeriesPath,
  VolumePath,
} from "./chart-primitives";
import { TooltipContent, useChartPointer } from "./chart-tooltip";
import type {
  ChartPoint,
  ChartSeriesSpec,
  OscillatorSpec,
  StockChartProps,
} from "./types";

export interface HandleBrushClearAndReset {
  clear: () => void;
  reset: () => void;
}

const MOBILE_MAX = 500;

function normalizePoints(points: ChartPoint[]): ChartPoint[] {
  if (!points.length) return points;
  const norm = normalizeToPercentChange(points.map((p) => p.v));
  return points.map((p, i) => ({ t: p.t, v: norm[i] ?? 0 }));
}

function StockChartInner({
  width,
  height,
  series,
  volume,
  indicators = [],
  oscillators = [],
  leftAxis,
  rightAxis,
  viewMode = "absolute",
  showBrush = true,
  variant = "full",
  decimationTargetPerPx = 2,
  handleRef,
}: StockChartProps & {
  width: number;
  height: number;
  handleRef?: React.Ref<HandleBrushClearAndReset>;
}) {
  const brushRef = useRef<BaseBrush | null>(null);
  const [filtered, setFiltered] = useState<[number, number] | null>(null);
  // Unique per-instance prefix so SVG gradient ids never collide when multiple
  // StockCharts render on one page (e.g. several dashboard widgets).
  const gid = useId();
  const { containerRef, TooltipInPortal } = useTooltipInPortal({
    detectBounds: true,
    scroll: true,
  });

  const isMobile = width > 0 && width <= MOBILE_MAX;
  const compact = variant === "compact";
  const hasRight = series.some((s) => s.axis === "right");

  const margin = useMemo(
    () => ({
      top: 8,
      right: hasRight && !compact ? 44 : 12,
      bottom: 24,
      left: compact ? 32 : 44,
    }),
    [hasRight, compact],
  );

  const showVolume = !!volume?.length && !compact && !isMobile;
  const showOsc = oscillators.length > 0 && !compact;
  const showBrushBand = showBrush && !compact && !isMobile && width > 0;

  const brushH = showBrushBand ? 56 : 0;
  const oscH = showOsc ? 84 : 0;
  const innerW = Math.max(0, width - margin.left - margin.right);
  const mainH = Math.max(
    0,
    height - margin.top - margin.bottom - brushH - oscH,
  );

  // Apply the brush domain filter, then decimate each series ONCE; remember the
  // kept indices so indicator arrays subsample identically.
  const decBySeries = useMemo(() => {
    const threshold = Math.max(innerW * decimationTargetPerPx, 2);
    const m = new Map<string, { points: ChartPoint[]; indices: number[] }>();
    for (const s of series) {
      const raw = filtered
        ? s.points.filter((p) => p.t >= filtered[0] && p.t <= filtered[1])
        : s.points;
      // Indices are into the (possibly filtered) array; align indicators below
      // using the same filter+indices via the index map stored alongside.
      const filteredIdx: number[] = [];
      if (filtered) {
        for (let i = 0; i < s.points.length; i++) {
          const p = s.points[i]!;
          if (p.t >= filtered[0] && p.t <= filtered[1]) filteredIdx.push(i);
        }
      }
      const d = decimate(raw, threshold, { keepExtrema: true });
      // map decimated indices back to ORIGINAL series indices
      const origIndices = filtered
        ? d.indices.map((i) => filteredIdx[i]!)
        : d.indices;
      m.set(s.id, { points: d.points, indices: origIndices });
    }
    return m;
  }, [series, innerW, decimationTargetPerPx, filtered]);

  const renderSeries: ChartSeriesSpec[] = useMemo(
    () =>
      series.map((s) => {
        const d = decBySeries.get(s.id)!;
        const pts = viewMode === "normalized" ? normalizePoints(d.points) : d.points;
        return { ...s, points: pts };
      }),
    [series, decBySeries, viewMode],
  );

  const { dateScale, leftScale, rightScale } = useChartScales({
    series: renderSeries,
    width,
    height: mainH + margin.top + margin.bottom,
    margin,
    leftDomain: leftAxis?.domain,
    rightDomain: rightAxis?.domain,
  });

  const scaleForAxis = useCallback(
    (axis: "left" | "right") => (axis === "right" ? rightScale : leftScale),
    [leftScale, rightScale],
  );

  // Volume scale: bottom ~28% of the main panel.
  const decVolume = useMemo(() => {
    if (!showVolume || !volume) return [] as ChartPoint[];
    const raw = filtered
      ? volume.filter((p) => p.t >= filtered[0] && p.t <= filtered[1])
      : volume;
    return decimate(raw, Math.max(innerW * decimationTargetPerPx, 2)).points;
  }, [showVolume, volume, filtered, innerW, decimationTargetPerPx]);

  const volumeScale = useMemo(() => {
    const maxV = decVolume.reduce((m, p) => Math.max(m, p.v), 0) || 1;
    return scaleLinear<number>({
      domain: [0, maxV],
      range: [mainH, mainH * 0.72],
    });
  }, [decVolume, mainH]);

  const { hover, onMove, onLeave } = useChartPointer({
    xScale: dateScale,
    series: renderSeries,
    marginLeft: margin.left,
  });

  // Brush overview: aggregate ALL series' points so the band + selectable range
  // span the full dataset (not just series[0]). Hard-decimated for the overview.
  const brushSeries = useMemo(() => {
    const all: ChartPoint[] = [];
    for (const s of series) for (const p of s.points) all.push(p);
    if (!all.length) return [] as ChartPoint[];
    all.sort((a, b) => a.t - b.t);
    return decimate(all, Math.max(Math.floor(innerW / 2), 2)).points;
  }, [series, innerW]);

  // Reduce loops (not Math.min(...arr) spread) — safe for any point count.
  const brushDomain = useMemo(() => {
    let tLo = Infinity;
    let tHi = -Infinity;
    let vLo = Infinity;
    let vHi = -Infinity;
    for (const p of brushSeries) {
      if (p.t < tLo) tLo = p.t;
      if (p.t > tHi) tHi = p.t;
      if (p.v < vLo) vLo = p.v;
      if (p.v > vHi) vHi = p.v;
    }
    if (!Number.isFinite(tLo)) {
      tLo = 0;
      tHi = 1;
      vLo = 0;
      vHi = 1;
    }
    return { tLo, tHi, vLo, vHi };
  }, [brushSeries]);

  const brushDateScale = useMemo(
    () =>
      scaleTime<number>({
        domain: [new Date(brushDomain.tLo), new Date(brushDomain.tHi)],
        range: [0, innerW],
      }),
    [brushDomain, innerW],
  );

  const brushValueScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: [brushDomain.vLo, brushDomain.vHi],
        range: [brushH - 16, 0],
      }),
    [brushDomain, brushH],
  );

  const onBrushChange = useCallback((bounds: Bounds | null) => {
    if (!bounds) {
      setFiltered(null);
      return;
    }
    const { x0, x1 } = bounds;
    if (x1 - x0 < 1) {
      setFiltered(null);
      return;
    }
    setFiltered([x0, x1]);
  }, []);

  useImperativeHandle(
    handleRef,
    () => ({
      clear: () => {
        brushRef.current?.reset();
        setFiltered(null);
      },
      reset: () => {
        brushRef.current?.reset();
        setFiltered(null);
      },
    }),
    [],
  );

  if (width < 10) return null;

  const oscTop = margin.top + mainH + (showOsc ? 12 : 0);
  const brushTop = height - brushH + 4;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <svg width={width} height={height} data-points={renderSeries[0]?.points.length ?? 0}>
        <Group left={margin.left} top={margin.top}>
          <Grid yScale={leftScale} width={innerW} />
          {showVolume && (
            <VolumePath data={decVolume} xScale={dateScale} yScale={volumeScale} />
          )}
          {renderSeries.map((s, i) => (
            <SeriesPath
              key={s.id}
              series={s}
              xScale={dateScale}
              yScale={scaleForAxis(s.axis)}
              gradientId={`${gid}-grad-${i}`}
            />
          ))}
          {indicators.map((ind) => {
            const d = decBySeries.get(ind.seriesId);
            const target = series.find((s) => s.id === ind.seriesId);
            if (!d || !target) return null;
            // Indicator value arrays must be aligned 1:1 to the target series'
            // RAW points; a length mismatch means a caller contract violation
            // that would silently produce gaps — skip + warn rather than corrupt.
            if (
              process.env.NODE_ENV !== "production" &&
              ind.values.length !== target.points.length
            ) {
              console.error(
                `StockChart: indicator "${ind.id}" values length (${ind.values.length}) ` +
                  `!= series "${ind.seriesId}" points (${target.points.length}); skipping.`,
              );
            }
            if (ind.values.length !== target.points.length) return null;
            const yScale = scaleForAxis(target.axis);
            const sub = (arr?: (number | null)[]) =>
              arr ? d.indices.map((i) => arr[i] ?? null) : undefined;
            const pts = d.points;
            return (
              <Group key={ind.id}>
                {ind.upper && (
                  <IndicatorPath points={pts} values={sub(ind.upper)!} xScale={dateScale} yScale={yScale} color={ind.color} dash="4,3" />
                )}
                {ind.lower && (
                  <IndicatorPath points={pts} values={sub(ind.lower)!} xScale={dateScale} yScale={yScale} color={ind.color} dash="4,3" />
                )}
                {ind.middle && (
                  <IndicatorPath points={pts} values={sub(ind.middle)!} xScale={dateScale} yScale={yScale} color={ind.color} />
                )}
                <IndicatorPath points={pts} values={sub(ind.values)!} xScale={dateScale} yScale={yScale} color={ind.color} dash={ind.dash} />
              </Group>
            );
          })}
          <Axes
            xScale={dateScale}
            leftScale={leftScale}
            rightScale={rightScale}
            innerW={innerW}
            innerH={mainH}
            hasRight={hasRight && !compact}
            leftFormat={leftAxis?.format}
            rightFormat={rightAxis?.format}
            compact={compact}
          />
          {hover && (
            <Crosshair
              x={hover.cx}
              innerH={mainH}
              dots={hover.entries.map((e) => ({
                y: scaleForAxis(e.series.axis)(e.point.v) ?? 0,
                color: e.series.color,
              }))}
            />
          )}
          {/* pointer capture */}
          <rect
            x={0}
            y={0}
            width={innerW}
            height={mainH}
            fill="transparent"
            onMouseMove={onMove}
            onTouchMove={onMove}
            onMouseLeave={onLeave}
            onTouchEnd={onLeave}
          />
        </Group>

        {showOsc && (
          <Group left={margin.left} top={oscTop} data-chart="oscillator">
            <OscillatorPanel
              oscillators={oscillators}
              refIndices={decBySeries.get(series[0]?.id ?? "")?.indices ?? []}
              points={decBySeries.get(series[0]?.id ?? "")?.points ?? []}
              width={innerW}
              height={oscH - 16}
              xScale={dateScale}
            />
          </Group>
        )}

        {showBrushBand && (
          <Group left={margin.left} top={brushTop}>
            <AreaClosed<ChartPoint>
              data={brushSeries}
              x={(d) => brushDateScale(new Date(d.t)) ?? 0}
              y={(d) => brushValueScale(d.v) ?? 0}
              yScale={brushValueScale}
              fill={chartTheme.volume}
              fillOpacity={0.25}
              stroke="none"
              curve={curveMonotoneX}
            />
            <Brush
              innerRef={brushRef}
              xScale={brushDateScale}
              yScale={brushValueScale}
              width={innerW}
              height={Math.max(brushH - 16, 8)}
              handleSize={8}
              resizeTriggerAreas={["left", "right"]}
              brushDirection="horizontal"
              onChange={onBrushChange}
              onClick={() => setFiltered(null)}
              selectedBoxStyle={{
                fill: "hsl(var(--primary))",
                fillOpacity: 0.12,
                stroke: "hsl(var(--primary))",
                strokeOpacity: 0.4,
              }}
              useWindowMoveEvents
            />
          </Group>
        )}
      </svg>

      {hover && (
        <TooltipInPortal
          key={Math.round(hover.cx)}
          left={hover.cx + margin.left + 12}
          top={margin.top + 8}
          style={{
            position: "absolute",
            background: chartTheme.tooltipBg,
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            padding: "8px 10px",
            boxShadow: "0 4px 12px hsl(var(--foreground) / 0.1)",
            pointerEvents: "none",
          }}
        >
          <TooltipContent hover={hover} leftAxis={leftAxis} rightAxis={rightAxis} />
        </TooltipInPortal>
      )}
    </div>
  );
}

function OscillatorPanel({
  oscillators,
  refIndices,
  points,
  width,
  height,
  xScale,
}: {
  oscillators: OscillatorSpec[];
  refIndices: number[];
  points: ChartPoint[];
  width: number;
  height: number;
  xScale: ReturnType<typeof scaleTime<number>>;
}) {
  const osc = oscillators[0];
  if (!osc || !points.length) return null;
  const domain = osc.domain ?? [0, 100];
  const yScale = scaleLinear<number>({ domain, range: [height, 0] });
  // Subsample the original-length oscillator values by the same original indices
  // used for the reference series (mirrors the indicator subsampling contract).
  const oscValues = refIndices.map((i) => osc.values[i] ?? null);
  return (
    <g>
      <rect x={0} y={0} width={width} height={height} fill="hsl(var(--muted))" fillOpacity={0.25} rx={4} />
      {(osc.reference ?? []).map((lvl) => (
        <Line
          key={lvl}
          from={{ x: 0, y: yScale(lvl) ?? 0 }}
          to={{ x: width, y: yScale(lvl) ?? 0 }}
          stroke={chartTheme.grid}
          strokeDasharray="2,3"
          strokeOpacity={0.6}
        />
      ))}
      {(osc.extraLines ?? []).map((ln, i) => (
        <IndicatorPath
          key={i}
          points={points}
          values={refIndices.map((idx) => ln.values[idx] ?? null)}
          xScale={xScale}
          yScale={yScale}
          color={ln.color}
          dash={ln.dash}
        />
      ))}
      <IndicatorPath
        points={points}
        values={oscValues}
        xScale={xScale}
        yScale={yScale}
        color={osc.color}
        dash={osc.dash}
      />
    </g>
  );
}

export const StockChart = forwardRef<HandleBrushClearAndReset, StockChartProps>(
  function StockChart(props, ref) {
    const height = props.height ?? 360;
    return (
      <div style={{ width: "100%", height }}>
        <ParentSize>
          {({ width }) => (
            <StockChartInner {...props} width={width} height={height} handleRef={ref} />
          )}
        </ParentSize>
      </div>
    );
  },
);

export default StockChart;
