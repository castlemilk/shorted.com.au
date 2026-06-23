"use client";

import { useCallback, useMemo, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { AreaClosed, Line, LinePath, Bar } from "@visx/shape";
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
import { localPoint } from "@visx/event";
import { TooltipWithBounds, useTooltip } from "@visx/tooltip";
import { bisector } from "d3-array";
import {
  AUS_REAL_HPI,
  INVESTOR_SHARE,
  NEG_GEARED_LANDLORDS,
  POLICY_MARKERS,
} from "../data/series";
import type { YearValue } from "../data/types";
import { AMBER, AXIS_LINE, AXIS_TEXT, MARKER, OLIVE, RUST, TOOLTIP_STYLE } from "./chart-theme";
import { LegendDot, SegmentedToggle } from "./chart-ui";

type SecKey = "investor" | "landlords";

const SECONDARY: Record<
  SecKey,
  {
    label: string;
    color: string;
    data: YearValue[];
    domain: [number, number];
    fmt: (v: number) => string;
    axisFmt: (v: number) => string;
  }
> = {
  investor: {
    label: "Investor share of new lending",
    color: OLIVE,
    data: INVESTOR_SHARE,
    domain: [0, 50],
    fmt: (v) => `${v.toFixed(0)}%`,
    axisFmt: (v) => `${v}%`,
  },
  landlords: {
    label: "Negatively-geared landlords",
    color: RUST,
    data: NEG_GEARED_LANDLORDS,
    domain: [0, 1_400_000],
    fmt: (v) => `${(v / 1e6).toFixed(2)}m`,
    axisFmt: (v) => `${(v / 1e6).toFixed(1)}m`,
  },
};

const MARGIN = { top: 18, right: 50, bottom: 28, left: 40 };
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

function ChartInner({ width, secKey }: { width: number; secKey: SecKey }) {
  const sec = SECONDARY[secKey];
  const { tooltipData, tooltipLeft, tooltipTop, tooltipOpen, showTooltip, hideTooltip } =
    useTooltip<{ year: number; price: number; secVal?: number }>();

  const innerWidth = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerHeight = HEIGHT - MARGIN.top - MARGIN.bottom;
  const small = width < 520;

  const xScale = useMemo(
    () => scaleLinear({ domain: [1980, 2025], range: [0, innerWidth] }),
    [innerWidth],
  );
  const priceScale = useMemo(
    () => scaleLinear({ domain: [0, 145], range: [innerHeight, 0], nice: true }),
    [innerHeight],
  );
  const secScale = useMemo(
    () => scaleLinear({ domain: sec.domain, range: [innerHeight, 0], nice: true }),
    [innerHeight, sec.domain],
  );

  const handleMove = useCallback(
    (event: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
      const p = localPoint(event);
      if (!p) return;
      const year = Math.round(xScale.invert(p.x - MARGIN.left));
      const idx = bisectYear(AUS_REAL_HPI, year, 1);
      const a = AUS_REAL_HPI[idx - 1];
      const b = AUS_REAL_HPI[idx];
      const price = b && Math.abs(b.year - year) < Math.abs((a?.year ?? -Infinity) - year) ? b : a;
      if (!price) return;
      const secPoint = nearest(sec.data, price.year);
      showTooltip({
        tooltipData: {
          year: price.year,
          price: price.value,
          secVal: secPoint && Math.abs(secPoint.year - price.year) <= 1 ? secPoint.value : undefined,
        },
        tooltipLeft: xScale(price.year) + MARGIN.left,
        tooltipTop: priceScale(price.value) + MARGIN.top,
      });
    },
    [xScale, priceScale, sec.data, showTooltip],
  );

  if (innerWidth <= 0) return null;

  return (
    <div className="relative" style={{ width, height: HEIGHT }}>
      <svg width={width} height={HEIGHT} role="img" aria-label="Australian real house prices versus property-tax policy">
        <LinearGradient id="policy-price-grad" from={AMBER} fromOpacity={0.22} to={AMBER} toOpacity={0.02} />
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* policy event markers */}
          {POLICY_MARKERS.map((m) => (
            <Line
              key={m.year}
              from={{ x: xScale(m.year), y: 0 }}
              to={{ x: xScale(m.year), y: innerHeight }}
              stroke={MARKER}
              strokeWidth={1}
              strokeDasharray="3,3"
              opacity={0.55}
            />
          ))}
          {/* marker labels: the NG experiment and the CGT switch */}
          <text x={xScale(1986)} y={-6} fill={AMBER} fontSize={small ? 8 : 9.5} textAnchor="middle" className="font-mono">
            {small ? "NG ’85–87" : "NG quarantine ’85–87"}
          </text>
          <text x={xScale(1999)} y={-6} fill={AMBER} fontSize={small ? 8 : 9.5} textAnchor="middle" className="font-mono">
            {small ? "CGT ’99" : "50% CGT discount ’99"}
          </text>

          {/* price (left axis) */}
          <AreaClosed<YearValue>
            data={AUS_REAL_HPI}
            x={(d) => xScale(d.year)}
            y={(d) => priceScale(d.value)}
            yScale={priceScale}
            curve={curveMonotoneX}
            fill="url(#policy-price-grad)"
          />
          <LinePath<YearValue>
            data={AUS_REAL_HPI}
            x={(d) => xScale(d.year)}
            y={(d) => priceScale(d.value)}
            curve={curveMonotoneX}
            stroke={AMBER}
            strokeWidth={2}
          />

          {/* secondary (right axis) */}
          <LinePath<YearValue>
            data={sec.data}
            x={(d) => xScale(d.year)}
            y={(d) => secScale(d.value)}
            curve={curveMonotoneX}
            stroke={sec.color}
            strokeWidth={1.75}
            strokeDasharray="5,3"
          />
          {sec.data.map((d) => (
            <circle key={d.year} cx={xScale(d.year)} cy={secScale(d.value)} r={2.5} fill={sec.color} />
          ))}

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
            scale={priceScale}
            numTicks={4}
            stroke={AXIS_LINE}
            hideTicks
            tickLabelProps={() => ({ fill: AXIS_TEXT, fontSize: 9, textAnchor: "end", dx: "-0.25em", dy: "0.3em" })}
          />
          <AxisRight
            left={innerWidth}
            scale={secScale}
            numTicks={4}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => sec.axisFmt(Number(v))}
            tickLabelProps={() => ({ fill: sec.color, fontSize: 9, textAnchor: "start", dx: "0.25em", dy: "0.3em" })}
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
              <circle cx={xScale(tooltipData.year)} cy={priceScale(tooltipData.price)} r={3.5} fill={AMBER} pointerEvents="none" />
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
            <span style={{ color: AMBER }}>Real price index</span>{" "}
            <span className="font-mono tabular-nums">{tooltipData.price.toFixed(1)}</span>
          </div>
          {tooltipData.secVal !== undefined ? (
            <div>
              <span style={{ color: sec.color }}>{sec.label}</span>{" "}
              <span className="font-mono tabular-nums">{sec.fmt(tooltipData.secVal)}</span>
            </div>
          ) : null}
        </TooltipWithBounds>
      ) : null}
    </div>
  );
}

/**
 * Dashboard ② — Australian real house prices (BIS, 2010=100) against the
 * property-tax settings that supercharged investor demand: the 1985-87 negative-
 * gearing experiment and the 1999 50% CGT discount. Toggle the secondary series
 * between investor share of new lending and the count of negatively-geared
 * landlords.
 */
export function PolicyPriceChart() {
  const [secKey, setSecKey] = useState<SecKey>("investor");
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3 px-2 sm:px-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <LegendDot color={AMBER} label="Real house prices (2010=100)" />
          <LegendDot color={SECONDARY[secKey].color} label={SECONDARY[secKey].label} />
        </div>
        <SegmentedToggle<SecKey>
          ariaLabel="Secondary series"
          value={secKey}
          onChange={setSecKey}
          options={[
            { value: "investor", label: "Investor %" },
            { value: "landlords", label: "Landlords" },
          ]}
        />
      </div>
      <ParentSize className="min-w-0">
        {({ width }) => (width > 0 ? <ChartInner width={width} secKey={secKey} /> : null)}
      </ParentSize>
    </div>
  );
}
