"use client";

import { useCallback, useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear, scaleTime } from "@visx/scale";
import { Bar, LinePath } from "@visx/shape";
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { bisector } from "d3-array";
import { format } from "date-fns";

export interface SeriesPoint {
  date: Date;
  value: number;
}

// Primary = the house amber accent; secondary = a muted slate that reads on
// both the warm-white and terminal-black themes (no slate token exists, so it's
// pinned here). Independent y-domains — the two series are unlike quantities.
const PRIMARY = "hsl(var(--primary))";
const SECONDARY = "#7c8aa0";
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const AXIS_LINE = "hsl(var(--border))";

const MARGIN = { top: 10, right: 52, bottom: 24, left: 48 };

// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectDate = bisector<SeriesPoint, Date>((d) => d.date).left;

/** Nearest observation in a series to a target date (by absolute distance). */
function nearest(points: SeriesPoint[], target: Date): SeriesPoint | undefined {
  if (points.length === 0) return undefined;
  const index = bisectDate(points, target, 1);
  const d0 = points[index - 1];
  const d1 = points[index];
  if (!d0) return d1;
  if (!d1) return d0;
  return target.valueOf() - d0.date.valueOf() > d1.date.valueOf() - target.valueOf()
    ? d1
    : d0;
}

function yDomain(points: SeriesPoint[]): [number, number] {
  const values = points.map((d) => d.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = max - min > 0 ? (max - min) * 0.1 : Math.abs(max) * 0.1 || 1;
  return [min - pad, max + pad];
}

export function yDomainsFor(
  primary: SeriesPoint[],
  secondary: SeriesPoint[],
  sharedScale: boolean,
): {
  primary: [number, number];
  secondary: [number, number];
} {
  if (sharedScale) {
    const shared = yDomain([...primary, ...secondary]);
    return { primary: shared, secondary: shared };
  }
  return {
    primary: yDomain(primary),
    secondary: yDomain(secondary),
  };
}

export interface DualAxisChartProps {
  primary: SeriesPoint[];
  secondary: SeriesPoint[];
  primaryLabel: string;
  secondaryLabel: string;
  formatPrimary?: (value: number) => string;
  formatSecondary?: (value: number) => string;
  height?: number;
  ariaLabel: string;
  /** Plot like-unit series against one shared y-domain and show only the left axis. */
  sharedScale?: boolean;
}

interface HoverState {
  date: Date;
  p?: SeriesPoint;
  s?: SeriesPoint;
}

function ChartInner({
  primary,
  secondary,
  primaryLabel,
  secondaryLabel,
  formatPrimary,
  formatSecondary,
  width,
  height,
  ariaLabel,
  sharedScale,
}: Required<DualAxisChartProps> & { width: number }) {
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<HoverState>();

  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  // Shared time domain spans the union of both series so neither is clipped.
  const xScale = useMemo(() => {
    const dates = [...primary, ...secondary].map((d) => d.date.getTime());
    return scaleTime({
      domain: [new Date(Math.min(...dates)), new Date(Math.max(...dates))],
      range: [0, innerWidth],
    });
  }, [primary, secondary, innerWidth]);

  const yDomains = useMemo(
    () => yDomainsFor(primary, secondary, sharedScale),
    [primary, secondary, sharedScale],
  );
  const yPrimary = useMemo(
    () =>
      scaleLinear({
        domain: yDomains.primary,
        range: [innerHeight, 0],
        nice: true,
      }),
    [yDomains, innerHeight],
  );
  const ySecondary = useMemo(
    () =>
      sharedScale
        ? yPrimary
        : scaleLinear({
            domain: yDomains.secondary,
            range: [innerHeight, 0],
            nice: true,
          }),
    [sharedScale, yDomains, innerHeight, yPrimary],
  );

  const handleMouseMove = useCallback(
    (event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
      const point = localPoint(event);
      if (!point) return;
      const x0 = xScale.invert(point.x - MARGIN.left);
      const p = nearest(primary, x0);
      const s = nearest(secondary, x0);
      const anchor = p ?? s;
      if (!anchor) return;
      showTooltip({
        tooltipData: { date: x0, p, s },
        tooltipLeft: xScale(anchor.date) + MARGIN.left,
        tooltipTop: (p ? yPrimary(p.value) : ySecondary(s!.value)) + MARGIN.top,
      });
    },
    [primary, secondary, xScale, yPrimary, ySecondary, showTooltip],
  );

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} role="img" aria-label={ariaLabel}>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {secondary.length >= 2 && (
            <LinePath<SeriesPoint>
              data={secondary}
              x={(d) => xScale(d.date)}
              y={(d) => ySecondary(d.value)}
              curve={curveMonotoneX}
              stroke={SECONDARY}
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          )}
          {primary.length >= 2 && (
            <LinePath<SeriesPoint>
              data={primary}
              x={(d) => xScale(d.date)}
              y={(d) => yPrimary(d.value)}
              curve={curveMonotoneX}
              stroke={PRIMARY}
              strokeWidth={1.75}
            />
          )}
          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={width > 480 ? 6 : 4}
            stroke={AXIS_LINE}
            hideTicks
            tickLabelProps={() => ({
              fill: AXIS_TEXT,
              fontSize: 10,
              textAnchor: "middle" as const,
            })}
          />
          <AxisLeft
            scale={yPrimary}
            numTicks={4}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => formatPrimary(Number(v))}
            tickLabelProps={() => ({
              fill: PRIMARY,
              fontSize: 10,
              textAnchor: "end" as const,
              dx: "-0.25em",
              dy: "0.3em",
            })}
          />
          {!sharedScale ? (
            <AxisRight
              left={innerWidth}
              scale={ySecondary}
              numTicks={4}
              stroke={AXIS_LINE}
              hideTicks
              tickFormat={(v) => formatSecondary(Number(v))}
              tickLabelProps={() => ({
                fill: SECONDARY,
                fontSize: 10,
                textAnchor: "start" as const,
                dx: "0.25em",
                dy: "0.3em",
              })}
            />
          ) : null}
          {tooltipOpen && tooltipData?.p && (
            <circle
              cx={xScale(tooltipData.p.date)}
              cy={yPrimary(tooltipData.p.value)}
              r={3}
              fill={PRIMARY}
              pointerEvents="none"
            />
          )}
          {tooltipOpen && tooltipData?.s && (
            <circle
              cx={xScale(tooltipData.s.date)}
              cy={ySecondary(tooltipData.s.value)}
              r={3}
              fill={SECONDARY}
              pointerEvents="none"
            />
          )}
          <Bar
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handleMouseMove}
            onTouchMove={handleMouseMove}
            onMouseLeave={hideTooltip}
            onTouchEnd={hideTooltip}
          />
        </g>
      </svg>
      {tooltipOpen && tooltipData && (
        <TooltipWithBounds
          left={tooltipLeft}
          top={tooltipTop}
          className="pointer-events-none"
          style={{
            position: "absolute",
            backgroundColor: "hsl(var(--popover))",
            color: "hsl(var(--popover-foreground))",
            border: "1px solid hsl(var(--border))",
            borderRadius: 6,
            padding: "6px 8px",
            fontSize: 11,
          }}
        >
          <div className="mb-1 text-muted-foreground">
            {format((tooltipData.p ?? tooltipData.s)!.date, "MMM yyyy")}
          </div>
          <div className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: PRIMARY }}
            />
            <span className="text-muted-foreground">{primaryLabel}</span>
            <span className="ml-auto font-mono">
              {tooltipData.p ? formatPrimary(tooltipData.p.value) : "—"}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: SECONDARY }}
            />
            <span className="text-muted-foreground">{secondaryLabel}</span>
            <span className="ml-auto font-mono">
              {tooltipData.s ? formatSecondary(tooltipData.s.value) : "—"}
            </span>
          </div>
        </TooltipWithBounds>
      )}
    </div>
  );
}

/** Legend chip with the series' colour swatch. */
function LegendChip({ color, dashed, label }: { color: string; dashed?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <svg width={16} height={8} aria-hidden>
        <line
          x1={0}
          y1={4}
          x2={16}
          y2={4}
          stroke={color}
          strokeWidth={2}
          strokeDasharray={dashed ? "4 3" : undefined}
        />
      </svg>
      {label}
    </span>
  );
}

/**
 * A lean two-series line chart with independent left (amber, primary) and right
 * (slate, secondary) y-axes by default, or an opt-in shared y-scale for
 * like-unit comparisons, over a shared time x-axis. Built dedicated rather
 * than reusing the heavier multi-series StockChart panel — two arbitrary
 * economic series only need this. Purely presentational; data fetching lives in
 * the wrapping component. SSR-safe via the ssr:false loader chain.
 */
export function DualAxisChart({
  primary,
  secondary,
  primaryLabel,
  secondaryLabel,
  formatPrimary = (v) => v.toFixed(1),
  formatSecondary = (v) => v.toFixed(1),
  height = 260,
  ariaLabel,
  sharedScale = false,
}: DualAxisChartProps) {
  const hasAny = primary.length >= 2 || secondary.length >= 2;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <LegendChip color={PRIMARY} label={primaryLabel} />
        <LegendChip color={SECONDARY} dashed label={secondaryLabel} />
      </div>
      {hasAny ? (
        <div style={{ height }}>
          <ParentSize className="min-w-0">
            {({ width }) =>
              width > 0 ? (
                <ChartInner
                  primary={primary}
                  secondary={secondary}
                  primaryLabel={primaryLabel}
                  secondaryLabel={secondaryLabel}
                  formatPrimary={formatPrimary}
                  formatSecondary={formatSecondary}
                  width={width}
                  height={height}
                  ariaLabel={ariaLabel}
                  sharedScale={sharedScale}
                />
              ) : null
            }
          </ParentSize>
        </div>
      ) : (
        <div
          className="flex items-center justify-center text-sm text-muted-foreground"
          style={{ height }}
        >
          Not enough overlapping data yet
        </div>
      )}
    </div>
  );
}
