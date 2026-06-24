"use client";

import { useCallback, useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { AreaClosed, Line, LinePath, Bar } from "@visx/shape";
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { bisector } from "d3-array";
import { APRA_MARKERS, DEBT_TO_INCOME, DTI_PEAK, PRICE_TO_INCOME } from "../data/series";
import type { YearValue } from "../data/types";
import { AMBER, AXIS_LINE, AXIS_TEXT, MARKER, TOOLTIP_STYLE } from "./chart-theme";
import { LegendDot } from "./chart-ui";
import { useLiveYearValues } from "./use-live-year-values";

const P2I = "#06b6d4"; // cyan — price-to-income
const MARGIN = { top: 20, right: 46, bottom: 28, left: 36 };
const HEIGHT = 360;

// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectYear = bisector<YearValue, number>((d) => d.year).left;

function nearest(data: YearValue[], year: number): YearValue | undefined {
  let best: YearValue | undefined;
  let bestD = Infinity;
  for (const d of data) {
    const dist = Math.abs(d.year - year);
    if (dist < bestD) {
      bestD = dist;
      best = d;
    }
  }
  return best;
}

function ChartInner({ width }: { width: number }) {
  // price-to-income splices the live ABS-derived index (2015=100) onto the
  // baked OECD spine; falls back to baked if live is absent.
  const priceToIncome = useLiveYearValues("price_to_income", PRICE_TO_INCOME);
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<{ year: number; dti: number; p2i?: number }>();

  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const small = width < 520;

  const lastYear = useMemo(
    () => Math.max(2025, ...priceToIncome.map((d) => d.year), ...DEBT_TO_INCOME.map((d) => d.year)),
    [priceToIncome],
  );
  const xScale = useMemo(
    () => scaleLinear({ domain: [1990, lastYear], range: [0, innerWidth] }),
    [innerWidth, lastYear],
  );
  const dtiScale = useMemo(
    () => scaleLinear({ domain: [0, 200], range: [innerHeight, 0], nice: true }),
    [innerHeight],
  );
  const p2iScale = useMemo(
    () =>
      scaleLinear({
        domain: [0, Math.max(130, Math.ceil(Math.max(...priceToIncome.map((d) => d.value)) / 10) * 10)],
        range: [innerHeight, 0],
        nice: true,
      }),
    [innerHeight, priceToIncome],
  );

  const handleMove = useCallback(
    (event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
      const p = localPoint(event);
      if (!p) return;
      const year = Math.round(xScale.invert(p.x - MARGIN.left));
      const idx = bisectYear(DEBT_TO_INCOME, year, 1);
      const a = DEBT_TO_INCOME[idx - 1];
      const b = DEBT_TO_INCOME[idx];
      const dti = b && Math.abs(b.year - year) < Math.abs((a?.year ?? -Infinity) - year) ? b : a;
      if (!dti) return;
      const p2iPoint = nearest(priceToIncome, dti.year);
      showTooltip({
        tooltipData: {
          year: dti.year,
          dti: dti.value,
          p2i: p2iPoint && Math.abs(p2iPoint.year - dti.year) <= 2 ? p2iPoint.value : undefined,
        },
        tooltipLeft: xScale(dti.year) + MARGIN.left,
        tooltipTop: dtiScale(dti.value) + MARGIN.top,
      });
    },
    [xScale, dtiScale, showTooltip, priceToIncome],
  );

  if (innerWidth <= 0) return null;

  return (
    <div className="relative" style={{ width, height: HEIGHT }}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Household debt-to-income and house-price-to-income over time">
        <LinearGradient id="dti-grad" from={AMBER} fromOpacity={0.2} to={AMBER} toOpacity={0.02} />
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* APRA macroprudential markers */}
          {APRA_MARKERS.map((m) => (
            <Line
              key={m.year}
              from={{ x: xScale(m.year), y: 0 }}
              to={{ x: xScale(m.year), y: innerHeight }}
              stroke={MARKER}
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.5}
            />
          ))}
          <text x={xScale(2017)} y={-7} fill={MARKER} fontSize={small ? 8 : 9.5} textAnchor="middle" className="font-mono">
            {small ? "APRA brakes" : "APRA tightening ’14–’21"}
          </text>

          {/* debt-to-income (left) */}
          <AreaClosed<YearValue>
            data={DEBT_TO_INCOME}
            x={(d) => xScale(d.year)}
            y={(d) => dtiScale(d.value)}
            yScale={dtiScale}
            curve={curveMonotoneX}
            fill="url(#dti-grad)"
          />
          <LinePath<YearValue>
            data={DEBT_TO_INCOME}
            x={(d) => xScale(d.year)}
            y={(d) => dtiScale(d.value)}
            curve={curveMonotoneX}
            stroke={AMBER}
            strokeWidth={2}
          />

          {/* price-to-income (right) */}
          <LinePath<YearValue>
            data={priceToIncome}
            x={(d) => xScale(d.year)}
            y={(d) => p2iScale(d.value)}
            curve={curveMonotoneX}
            stroke={P2I}
            strokeWidth={1.75}
            strokeDasharray="5,3"
          />

          {/* DTI peak flag */}
          <circle cx={xScale(DTI_PEAK.year)} cy={dtiScale(DTI_PEAK.value)} r={3.5} fill={AMBER} />
          <text
            x={xScale(DTI_PEAK.year)}
            y={dtiScale(DTI_PEAK.value) - 8}
            fill={AMBER}
            fontSize={small ? 8.5 : 10}
            textAnchor={small ? "end" : "middle"}
            className="font-mono"
          >
            187% peak
          </text>

          <AxisBottom
            top={innerHeight}
            scale={xScale}
            numTicks={small ? 5 : 8}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => `${Number(v)}`}
            tickLabelProps={() => ({ fill: AXIS_TEXT, fontSize: 10, textAnchor: "middle" })}
          />
          <AxisLeft
            scale={dtiScale}
            numTicks={4}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => `${Number(v)}%`}
            tickLabelProps={() => ({ fill: AMBER, fontSize: 9, textAnchor: "end", dx: "-0.25em", dy: "0.3em" })}
          />
          <AxisRight
            left={innerWidth}
            scale={p2iScale}
            numTicks={4}
            stroke={AXIS_LINE}
            hideTicks
            tickLabelProps={() => ({ fill: P2I, fontSize: 9, textAnchor: "start", dx: "0.25em", dy: "0.3em" })}
          />

          {tooltipOpen && tooltipData ? (
            <>
              <Line
                from={{ x: xScale(tooltipData.year), y: 0 }}
                to={{ x: xScale(tooltipData.year), y: innerHeight }}
                stroke={AXIS_TEXT}
                strokeWidth={1}
                opacity={0.4}
                pointerEvents="none"
              />
              <circle cx={xScale(tooltipData.year)} cy={dtiScale(tooltipData.dti)} r={3.5} fill={AMBER} pointerEvents="none" />
            </>
          ) : null}

          <Bar
            x={0}
            y={0}
            width={innerWidth}
            height={innerHeight}
            fill="transparent"
            onMouseMove={handleMove}
            onTouchMove={handleMove}
            onMouseLeave={hideTooltip}
            onTouchEnd={hideTooltip}
          />
        </g>
      </svg>

      {tooltipOpen && tooltipData ? (
        <TooltipWithBounds left={tooltipLeft} top={tooltipTop} style={TOOLTIP_STYLE}>
          <div className="font-mono font-semibold">{tooltipData.year}</div>
          <div>
            <span style={{ color: AMBER }}>Debt-to-income</span>{" "}
            <span className="font-mono tabular-nums">{tooltipData.dti.toFixed(0)}%</span>
          </div>
          {tooltipData.p2i !== undefined ? (
            <div>
              <span style={{ color: P2I }}>Price-to-income</span>{" "}
              <span className="font-mono tabular-nums">{tooltipData.p2i.toFixed(0)}</span>
            </div>
          ) : null}
        </TooltipWithBounds>
      ) : null}
    </div>
  );
}

/**
 * Dashboard ③ — household debt-to-income (RBA, left axis) against the OECD
 * price-to-income index (right axis): the credit that bid prices up, and APRA's
 * attempts to tap the brakes. Debt-to-income tripled from 67% in 1990 to a
 * ~187% peak in 2017-18.
 */
export function BuyingPowerChart() {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-2 sm:px-3">
        <LegendDot color={AMBER} label="Household debt-to-income (%)" />
        <LegendDot color={P2I} label="Price-to-income (2015=100)" />
      </div>
      <ParentSize className="min-w-0">
        {({ width }) => (width > 0 ? <ChartInner width={width} /> : null)}
      </ParentSize>
    </div>
  );
}
