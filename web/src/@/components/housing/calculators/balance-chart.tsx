"use client";

import { useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { AreaClosed, LinePath } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
import { GridRows } from "@visx/grid";
import { AXIS_LINE, AXIS_TEXT, AMBER, MARKER } from "@/components/features/housing/charts/chart-theme";
import { LegendDot } from "@/components/features/housing/charts/chart-ui";
import { fmtAUDShort } from "./calc-ui";

const MARGIN = { top: 8, right: 8, bottom: 26, left: 48 };

interface BalanceChartProps {
  /** Baseline remaining balance per month (index 0 = start). */
  baseline: number[];
  /** With-extras remaining balance per month. */
  withExtras: number[];
  /** Whether extras differ from baseline (draws the second curve). */
  hasExtras: boolean;
  height?: number;
}

function ChartInner({
  baseline,
  withExtras,
  hasExtras,
  width,
  height,
}: BalanceChartProps & { width: number; height: number }) {
  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  const maxMonths = Math.max(baseline.length, withExtras.length) - 1;
  const maxBalance = Math.max(baseline[0] ?? 0, withExtras[0] ?? 0);

  const xScale = useMemo(
    () => scaleLinear({ domain: [0, Math.max(maxMonths, 1)], range: [0, innerWidth] }),
    [maxMonths, innerWidth],
  );
  const yScale = useMemo(
    () => scaleLinear({ domain: [0, maxBalance * 1.02], range: [innerHeight, 0], nice: true }),
    [maxBalance, innerHeight],
  );

  if (innerWidth <= 0 || innerHeight <= 0 || maxMonths < 1) return null;

  const x = (i: number) => xScale(i);
  const toPoints = (arr: number[]) => arr.map((v, i) => ({ i, v }));

  return (
    <svg width={width} height={height} role="img" aria-label="Remaining loan balance over time, baseline versus with extra repayments">
      <LinearGradient id="calc-balance-gradient" from={AMBER} fromOpacity={0.22} to={AMBER} toOpacity={0.02} />
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        <GridRows scale={yScale} width={innerWidth} numTicks={4} stroke={AXIS_LINE} strokeOpacity={0.5} />
        {/* baseline */}
        <LinePath
          data={toPoints(baseline)}
          x={(d) => x(d.i)}
          y={(d) => yScale(d.v)}
          curve={curveMonotoneX}
          stroke={MARKER}
          strokeWidth={1.5}
          strokeDasharray={hasExtras ? "4,3" : undefined}
        />
        {/* with-extras */}
        {hasExtras ? (
          <>
            <AreaClosed
              data={toPoints(withExtras)}
              x={(d) => x(d.i)}
              y={(d) => yScale(d.v)}
              yScale={yScale}
              curve={curveMonotoneX}
              fill="url(#calc-balance-gradient)"
            />
            <LinePath
              data={toPoints(withExtras)}
              x={(d) => x(d.i)}
              y={(d) => yScale(d.v)}
              curve={curveMonotoneX}
              stroke={AMBER}
              strokeWidth={1.75}
            />
          </>
        ) : null}
        <AxisBottom
          top={innerHeight}
          scale={xScale}
          numTicks={width > 480 ? 7 : 4}
          stroke={AXIS_LINE}
          hideTicks
          tickFormat={(v) => `${Math.round(Number(v) / 12)}y`}
          tickLabelProps={() => ({ fill: AXIS_TEXT, fontSize: 10, textAnchor: "middle" as const })}
        />
        <AxisLeft
          scale={yScale}
          numTicks={4}
          stroke={AXIS_LINE}
          hideTicks
          tickFormat={(v) => fmtAUDShort(Number(v))}
          tickLabelProps={() => ({
            fill: AXIS_TEXT,
            fontSize: 10,
            textAnchor: "end" as const,
            dx: "-0.25em",
            dy: "0.3em",
          })}
        />
      </g>
    </svg>
  );
}

/** Remaining-balance chart: dashed baseline vs amber with-extras curve. */
export function BalanceChart({ baseline, withExtras, hasExtras, height = 240 }: BalanceChartProps) {
  return (
    <div>
      <div style={{ height }}>
        <ParentSize className="min-w-0">
          {({ width }) =>
            width > 0 ? (
              <ChartInner
                baseline={baseline}
                withExtras={withExtras}
                hasExtras={hasExtras}
                width={width}
                height={height}
              />
            ) : null
          }
        </ParentSize>
      </div>
      <div className="mt-2 flex gap-4">
        <LegendDot color={MARKER} label="Baseline" />
        {hasExtras ? <LegendDot color={AMBER} label="With extras / offset" /> : null}
      </div>
    </div>
  );
}
