"use client";

import { useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { LinePath } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { GridRows } from "@visx/grid";
import {
  AXIS_LINE,
  AXIS_TEXT,
  AMBER,
  OLIVE,
} from "@/components/features/housing/charts/chart-theme";
import { LegendDot } from "@/components/features/housing/charts/chart-ui";
import type { RentVsBuyYearPoint } from "@/lib/housing/rent-vs-buy";
import { fmtAUDShort } from "./calc-ui";

const MARGIN = { top: 8, right: 8, bottom: 26, left: 48 };

interface RentVsBuyChartProps {
  /** Net position per year for both paths (serializable — no functions). */
  perYear: RentVsBuyYearPoint[];
  /** Breakeven year to mark, if any. */
  breakevenYear?: number | null;
  height?: number;
}

function ChartInner({
  perYear,
  breakevenYear,
  width,
  height,
}: RentVsBuyChartProps & { width: number; height: number }) {
  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  const maxYear = perYear[perYear.length - 1]?.year ?? 1;
  const maxValue = useMemo(
    () => Math.max(1, ...perYear.map((p) => Math.max(p.buyNet, p.rentNet))),
    [perYear],
  );

  const xScale = useMemo(
    () => scaleLinear({ domain: [0, Math.max(maxYear, 1)], range: [0, innerWidth] }),
    [maxYear, innerWidth],
  );
  const yScale = useMemo(
    () => scaleLinear({ domain: [0, maxValue * 1.05], range: [innerHeight, 0], nice: true }),
    [maxValue, innerHeight],
  );

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <svg
      width={width}
      height={height}
      role="img"
      aria-label="Net position over time, buying versus renting"
    >
      <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
        <GridRows scale={yScale} width={innerWidth} numTicks={4} stroke={AXIS_LINE} strokeOpacity={0.5} />
        {breakevenYear != null ? (
          <line
            x1={xScale(breakevenYear)}
            x2={xScale(breakevenYear)}
            y1={0}
            y2={innerHeight}
            stroke={AXIS_TEXT}
            strokeWidth={1}
            strokeDasharray="3,3"
            strokeOpacity={0.6}
          />
        ) : null}
        <LinePath
          data={perYear}
          x={(d) => xScale(d.year)}
          y={(d) => yScale(d.rentNet)}
          curve={curveMonotoneX}
          stroke={OLIVE}
          strokeWidth={1.75}
        />
        <LinePath
          data={perYear}
          x={(d) => xScale(d.year)}
          y={(d) => yScale(d.buyNet)}
          curve={curveMonotoneX}
          stroke={AMBER}
          strokeWidth={1.75}
        />
        <AxisBottom
          top={innerHeight}
          scale={xScale}
          numTicks={Math.min(maxYear, width > 480 ? 8 : 5)}
          stroke={AXIS_LINE}
          hideTicks
          tickFormat={(v) => `${Math.round(Number(v))}y`}
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

/** Net-worth-over-time chart: amber buy line vs olive rent line. */
export function RentVsBuyChart({ perYear, breakevenYear, height = 240 }: RentVsBuyChartProps) {
  return (
    <div>
      <div style={{ height }}>
        <ParentSize className="min-w-0">
          {({ width }) =>
            width > 0 ? (
              <ChartInner
                perYear={perYear}
                breakevenYear={breakevenYear}
                width={width}
                height={height}
              />
            ) : null
          }
        </ParentSize>
      </div>
      <div className="mt-2 flex gap-4">
        <LegendDot color={AMBER} label="Buy (net worth)" />
        <LegendDot color={OLIVE} label="Rent + invest" />
        {breakevenYear != null ? (
          <span className="font-mono text-[0.7rem] text-muted-foreground">
            ┆ breakeven yr {breakevenYear}
          </span>
        ) : null}
      </div>
    </div>
  );
}
