"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleTime, scaleLinear } from "@visx/scale";
import { Area, LinePath, Bar, Line } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { LinearGradient } from "@visx/gradient";
import { localPoint } from "@visx/event";
import { bisector } from "d3-array";
import { format } from "date-fns";
import { ToggleGroup, ToggleGroupItem } from "~/@/components/ui/toggle-group";
import { cn } from "~/@/lib/utils";
import { bankColor } from "~/@/components/charts/bank-theme";
import {
  BANK_BASKET_SERIES,
  BASKET_RECORD,
} from "./data/bank-basket-series";

type Mode = "dollar" | "percent";
type Win = "3m" | "6m" | "1y";

const WIN_WEEKS: Record<Win, number> = { "3m": 13, "6m": 26, "1y": 52 };
const MARGIN = { top: 16, right: 16, bottom: 26, left: 48 };
const AXIS_TEXT = "hsl(var(--muted-foreground))";
const AXIS_LINE = "hsl(var(--border))";
const RECORD_COLOR = "hsl(var(--primary))";

const fmtBn = (v: number) => `$${v < 10 ? v.toFixed(2) : v.toFixed(1)}bn`;
const fmtPct = (v: number) => `${v.toFixed(2)}%`;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeInOut = (t: number) =>
  t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

interface Slice {
  dates: number[];
  pct: Record<string, number[]>;
  dollar: Record<string, number[]>;
}

// eslint-disable-next-line @typescript-eslint/unbound-method
const bisectDate = bisector<number, number>((d) => d).left;

/**
 * "The Basket" — an interactive editorial chart for the big-four bank short bet.
 * Dollar mode stacks each bank's short value (shares × close) into a climbing
 * basket whose ceiling traces the record; the $/% toggle morphs it into four
 * overlaid percentage lines. Reads the baked weekly series (no live endpoint
 * exposes short shares historically) so the geometry always matches the prose.
 */
export function BankShortBasket({
  banks = "CBA,WBC,NAB,ANZ",
  window: winProp = "1y",
  mode: modeProp = "dollar",
  title = "Big four bank short positions",
}: {
  banks?: string;
  window?: Win;
  mode?: Mode;
  title?: string;
}) {
  const codes = useMemo(
    () =>
      banks
        .split(",")
        .map((c) => c.trim().toUpperCase())
        .filter((c) => BANK_BASKET_SERIES.dollar[c]?.length)
        // Always stack/list in the canonical bottom→top order (CBA first),
        // regardless of the order the prop happens to list them in.
        .sort(
          (a, b) =>
            BANK_BASKET_SERIES.codes.indexOf(a) -
            BANK_BASKET_SERIES.codes.indexOf(b),
        ),
    [banks],
  );

  const [mode, setMode] = useState<Mode>(modeProp);
  const [win, setWin] = useState<Win>(winProp);
  const [hovered, setHovered] = useState<string | null>(null);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const m = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(m.matches);
    const on = () => setReduced(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  const slice = useMemo<Slice>(() => {
    const s = BANK_BASKET_SERIES;
    const n = s.dates.length;
    const count = Math.min(n, (WIN_WEEKS[win] ?? WIN_WEEKS["1y"]) + 1);
    const start = Math.max(0, n - count);
    const dates = s.dates.slice(start);
    const pct: Record<string, number[]> = {};
    const dollar: Record<string, number[]> = {};
    for (const c of codes) {
      pct[c] = s.pct[c]!.slice(start);
      dollar[c] = s.dollar[c]!.slice(start);
    }
    return { dates, pct, dollar };
  }, [codes, win]);

  if (codes.length === 0 || slice.dates.length < 2) return null;

  const lastIdx = slice.dates.length - 1;
  const latestTotal = codes.reduce((s, c) => s + slice.dollar[c]![lastIdx]!, 0);
  const cbaShare = slice.dollar.CBA
    ? (slice.dollar.CBA[lastIdx]! / latestTotal) * 100
    : 0;

  return (
    <figure className="my-8 overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold tracking-tight text-foreground">
            {title}
          </div>
          <div className="mt-0.5 font-mono text-xs text-muted-foreground">
            {mode === "dollar" ? (
              <>
                Basket{" "}
                <span className="text-foreground">{fmtBn(latestTotal)}</span>
                {slice.dollar.CBA ? (
                  <>
                    {" · CBA "}
                    <span className="text-foreground">
                      {cbaShare.toFixed(0)}%
                    </span>{" "}
                    of it
                  </>
                ) : null}
              </>
            ) : (
              <>short interest, % of shares on issue</>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ModeToggle mode={mode} onMode={setMode} />
          <WinToggle win={win} onWin={setWin} />
        </div>
      </div>

      <div className="h-[320px] w-full px-1 sm:px-2">
        <ParentSize className="min-w-0">
          {({ width }) =>
            width > 0 ? (
              <BasketCanvas
                width={width}
                height={320}
                codes={codes}
                slice={slice}
                mode={mode}
                hovered={hovered}
                reduced={reduced}
              />
            ) : null
          }
        </ParentSize>
      </div>

      <Legend
        codes={codes}
        slice={slice}
        mode={mode}
        hovered={hovered}
        onHover={setHovered}
      />

      <figcaption className="border-t border-border px-4 py-2 text-[11px] leading-relaxed text-muted-foreground">
        Short value = reported short shares × last close. Weekly ASIC data, as of{" "}
        {format(new Date(BANK_BASKET_SERIES.asOf + "T00:00:00Z"), "d MMM yyyy")}.
        Toggle $ / % — percentage of issue is shown unstacked because floats
        differ by bank.
      </figcaption>
    </figure>
  );
}

function ModeToggle({ mode, onMode }: { mode: Mode; onMode: (m: Mode) => void }) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={mode}
      onValueChange={(v) => v && onMode(v as Mode)}
      className="rounded-md border border-border bg-background p-0.5"
    >
      <ToggleGroupItem value="dollar" className="h-7 px-2.5 font-mono text-xs" aria-label="Dollar value">
        $
      </ToggleGroupItem>
      <ToggleGroupItem value="percent" className="h-7 px-2.5 font-mono text-xs" aria-label="Percent of issue">
        %
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

function WinToggle({ win, onWin }: { win: Win; onWin: (w: Win) => void }) {
  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={win}
      onValueChange={(v) => v && onWin(v as Win)}
      className="rounded-md border border-border bg-background p-0.5"
    >
      {(["3m", "6m", "1y"] as Win[]).map((w) => (
        <ToggleGroupItem key={w} value={w} className="h-7 px-2 font-mono text-xs">
          {w}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Legend({
  codes,
  slice,
  mode,
  hovered,
  onHover,
}: {
  codes: string[];
  slice: Slice;
  mode: Mode;
  hovered: string | null;
  onHover: (c: string | null) => void;
}) {
  const last = slice.dates.length - 1;
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border px-4 py-2.5">
      {codes.map((c) => {
        const val =
          mode === "dollar"
            ? fmtBn(slice.dollar[c]![last]!)
            : fmtPct(slice.pct[c]![last]!);
        const dim = hovered && hovered !== c;
        return (
          <button
            key={c}
            type="button"
            onMouseEnter={() => onHover(c)}
            onMouseLeave={() => onHover(null)}
            onFocus={() => onHover(c)}
            onBlur={() => onHover(null)}
            className={cn(
              "flex items-center gap-1.5 text-xs transition-opacity",
              dim ? "opacity-35" : "opacity-100",
            )}
          >
            <span
              className="h-2.5 w-2.5 rounded-[3px]"
              style={{ backgroundColor: bankColor(c) }}
            />
            <span className="font-semibold text-foreground">{c}</span>
            <span className="font-mono text-muted-foreground">{val}</span>
          </button>
        );
      })}
    </div>
  );
}

interface CanvasProps {
  width: number;
  height: number;
  codes: string[];
  slice: Slice;
  mode: Mode;
  hovered: string | null;
  reduced: boolean;
}

function BasketCanvas({ width, height, codes, slice, mode, hovered, reduced }: CanvasProps) {
  const { dates, pct, dollar } = slice;
  const innerW = Math.max(width - MARGIN.left - MARGIN.right, 0);
  const innerH = Math.max(height - MARGIN.top - MARGIN.bottom, 0);

  // Morph progress: 0 = dollar (stacked), 1 = percent (lines).
  const target = mode === "percent" ? 1 : 0;
  const [progress, setProgress] = useState(target);
  const progressRef = useRef(progress);
  useEffect(() => {
    if (reduced) {
      progressRef.current = target;
      setProgress(target);
      return;
    }
    const from = progressRef.current;
    if (from === target) return;
    let raf = 0;
    let start: number | null = null;
    const dur = 480;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const t = Math.min(1, (ts - start) / dur);
      const val = from + (target - from) * easeInOut(t);
      progressRef.current = val;
      setProgress(val);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, reduced]);

  // Entrance: fade bands in bottom-up once mounted.
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const xScale = useMemo(
    () => scaleTime({ domain: [dates[0]!, dates[dates.length - 1]!], range: [0, innerW] }),
    [dates, innerW],
  );
  const xPix = useMemo(() => dates.map((d) => xScale(d)), [dates, xScale]);

  const { maxTotal, maxPct } = useMemo(() => {
    let mt = 0;
    let mp = 0;
    for (let i = 0; i < dates.length; i++) {
      let sum = 0;
      for (const c of codes) {
        sum += dollar[c]![i]!;
        if (pct[c]![i]! > mp) mp = pct[c]![i]!;
      }
      if (sum > mt) mt = sum;
    }
    return { maxTotal: mt, maxPct: mp };
  }, [codes, dates, dollar, pct]);

  const yD = useMemo(
    // Keep the all-time RECORD line on-canvas even in a window whose own peak
    // sits below it (otherwise yD(record) goes negative and the line vanishes).
    () =>
      scaleLinear({
        domain: [0, Math.max(maxTotal, BASKET_RECORD.valueBn) * 1.08],
        range: [innerH, 0],
        nice: true,
      }),
    [maxTotal, innerH],
  );
  const yP = useMemo(
    () => scaleLinear({ domain: [0, maxPct * 1.12], range: [innerH, 0], nice: true }),
    [maxPct, innerH],
  );

  // Per-band pixel geometry at the current morph progress.
  const bands = useMemo(() => {
    return codes.map((code, bandIdx) => {
      const top: number[] = [];
      const bot: number[] = [];
      for (let i = 0; i < dates.length; i++) {
        // dollar stacked position
        let below = 0;
        for (let b = 0; b < bandIdx; b++) below += dollar[codes[b]!]![i]!;
        const dBot = yD(below);
        const dTop = yD(below + dollar[code]![i]!);
        // percent line position (filled to baseline)
        const pTop = yP(pct[code]![i]!);
        const pBot = innerH;
        top.push(lerp(dTop, pTop, progress));
        bot.push(lerp(dBot, pBot, progress));
      }
      return { code, bandIdx, top, bot };
    });
  }, [codes, dates, dollar, pct, yD, yP, innerH, progress]);

  if (innerW <= 0 || innerH <= 0) return null;

  // Axis crossfade trick: hide labels at the morph midpoint so the $→% value
  // swap is invisible. 1 at either end, 0 at p=0.5.
  const axisOpacity = Math.abs(2 * progress - 1);
  const showDollarAxis = progress < 0.5;
  const yActive = showDollarAxis ? yD : yP;
  const recordY = yD(BASKET_RECORD.valueBn);
  const recordVisible = (1 - progress) * 0.9;

  const idxClamp = (i: number) => Math.max(0, Math.min(dates.length - 1, i));

  const handleMove = (e: React.MouseEvent<SVGElement> | React.TouchEvent<SVGElement>) => {
    const p = localPoint(e);
    if (!p) return;
    const x0 = xScale.invert(p.x - MARGIN.left).getTime();
    const j = bisectDate(dates, x0, 1);
    const d0 = dates[j - 1];
    const d1 = dates[j];
    let idx = j - 1;
    if (d1 !== undefined && d0 !== undefined && x0 - d0 > d1 - x0) idx = j;
    setHoverIdx(idxClamp(idx));
  };

  const fillOpacity = lerp(0.82, 0.16, progress);

  return (
    <div className="relative" style={{ width, height }}>
      <svg width={width} height={height} role="img" aria-label="Big four bank short positions over time">
        <defs>
          {codes.map((c) => {
            const col = bankColor(c);
            return (
              <LinearGradient
                key={c}
                id={`bank-grad-${c}`}
                from={col}
                fromOpacity={0.55}
                to={col}
                toOpacity={0.06}
              />
            );
          })}
        </defs>
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {/* horizontal gridlines from the active scale, faded at the morph midpoint */}
          <g opacity={axisOpacity * 0.5}>
            {yActive.ticks(4).map((t) => (
              <line
                key={t}
                x1={0}
                x2={innerW}
                y1={yActive(t)}
                y2={yActive(t)}
                stroke={AXIS_LINE}
                strokeWidth={1}
              />
            ))}
          </g>

          {/* RECORD reference line (dollar mode) */}
          {recordVisible > 0.02 && recordY >= 0 && (
            <g opacity={recordVisible} pointerEvents="none">
              <Line
                from={{ x: 0, y: recordY }}
                to={{ x: innerW, y: recordY }}
                stroke={RECORD_COLOR}
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <text x={innerW - 2} y={recordY - 5} textAnchor="end" fontSize={9} fontWeight={600} fill={RECORD_COLOR}>
                RECORD {fmtBn(BASKET_RECORD.valueBn)}
              </text>
            </g>
          )}

          {/* bands, drawn bottom→top so CBA underlays */}
          {bands.map(({ code, bandIdx, top, bot }) => {
            const col = bankColor(code);
            const dim = hovered && hovered !== code ? 0.12 : 1;
            const idxArr = top.map((_, i) => i);
            return (
              <g
                key={code}
                style={{
                  opacity: mounted ? dim : 0,
                  transition: reduced ? undefined : `opacity 600ms ease ${bandIdx * 120}ms`,
                }}
              >
                <Area<number>
                  data={idxArr}
                  x={(i) => xPix[i]!}
                  y0={(i) => bot[i]!}
                  y1={(i) => top[i]!}
                  curve={curveMonotoneX}
                  fill={`url(#bank-grad-${code})`}
                  fillOpacity={fillOpacity}
                  stroke="none"
                />
                <LinePath<number>
                  data={idxArr}
                  x={(i) => xPix[i]!}
                  y={(i) => top[i]!}
                  curve={curveMonotoneX}
                  stroke={col}
                  strokeWidth={1.75}
                  strokeOpacity={0.95}
                />
              </g>
            );
          })}

          {/* hover crosshair + dots */}
          {hoverIdx !== null && (
            <g pointerEvents="none">
              <Line
                from={{ x: xPix[hoverIdx]!, y: 0 }}
                to={{ x: xPix[hoverIdx]!, y: innerH }}
                stroke="hsl(var(--foreground))"
                strokeWidth={1}
                strokeOpacity={0.25}
              />
              {bands.map(({ code, top }) => (
                <circle
                  key={code}
                  cx={xPix[hoverIdx]}
                  cy={top[hoverIdx]}
                  r={3}
                  fill={bankColor(code)}
                  stroke="hsl(var(--card))"
                  strokeWidth={1.5}
                  opacity={hovered && hovered !== code ? 0.2 : 1}
                />
              ))}
            </g>
          )}

          <AxisBottom
            top={innerH}
            scale={xScale}
            numTicks={width > 480 ? 6 : 4}
            stroke={AXIS_LINE}
            hideTicks
            tickFormat={(v) => format(new Date(+v), "MMM ''yy")}
            tickLabelProps={() => ({ fill: AXIS_TEXT, fontSize: 10, textAnchor: "middle" as const })}
          />
          <g opacity={axisOpacity}>
            <AxisLeft
              scale={yActive}
              numTicks={4}
              stroke={AXIS_LINE}
              hideTicks
              hideAxisLine
              tickFormat={(v) =>
                showDollarAxis ? `$${Number(v).toFixed(0)}bn` : `${Number(v).toFixed(1)}%`
              }
              tickLabelProps={() => ({
                fill: AXIS_TEXT,
                fontSize: 10,
                textAnchor: "end" as const,
                dx: "-0.25em",
                dy: "0.3em",
              })}
            />
          </g>

          <Bar
            x={0}
            y={0}
            width={innerW}
            height={innerH}
            fill="transparent"
            onMouseMove={handleMove}
            onTouchMove={handleMove}
            onMouseLeave={() => setHoverIdx(null)}
            onTouchEnd={() => setHoverIdx(null)}
          />
        </g>
      </svg>

      {hoverIdx !== null && (
        <BasketTooltip
          codes={codes}
          slice={slice}
          mode={mode}
          idx={hoverIdx}
          left={xPix[hoverIdx]! + MARGIN.left}
          width={width}
        />
      )}
    </div>
  );
}

function BasketTooltip({
  codes,
  slice,
  mode,
  idx,
  left,
  width,
}: {
  codes: string[];
  slice: Slice;
  mode: Mode;
  idx: number;
  left: number;
  width: number;
}) {
  const total = codes.reduce((s, c) => s + slice.dollar[c]![idx]!, 0);
  const ranked = [...codes].sort((a, b) =>
    mode === "dollar"
      ? slice.dollar[b]![idx]! - slice.dollar[a]![idx]!
      : slice.pct[b]![idx]! - slice.pct[a]![idx]!,
  );
  // flip the card to the left of the cursor when near the right edge
  const flip = left > width - 168;
  return (
    <div
      className="pointer-events-none absolute top-3 z-10 w-[160px] rounded-lg border border-border bg-popover/95 p-2.5 text-popover-foreground shadow-lg backdrop-blur"
      style={{ left: flip ? left - 168 : left + 8 }}
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          {format(new Date(slice.dates[idx]!), "d MMM yyyy")}
        </span>
        {mode === "dollar" && (
          <span className="font-mono text-xs font-semibold text-foreground">{fmtBn(total)}</span>
        )}
      </div>
      <div className="space-y-1">
        {ranked.map((c) => {
          const dv = slice.dollar[c]![idx]!;
          const share = total > 0 ? (dv / total) * 100 : 0;
          return (
            <div key={c} className="flex items-center gap-1.5 text-[11px]">
              <span className="h-2 w-2 rounded-[2px]" style={{ backgroundColor: bankColor(c) }} />
              <span className="w-8 font-semibold text-foreground">{c}</span>
              {mode === "dollar" ? (
                <span className="ml-auto font-mono text-muted-foreground">
                  {fmtBn(dv)} · {share.toFixed(0)}%
                </span>
              ) : (
                <span className="ml-auto font-mono text-muted-foreground">
                  {fmtPct(slice.pct[c]![idx]!)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
