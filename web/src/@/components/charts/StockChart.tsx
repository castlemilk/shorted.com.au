"use client";

import React, {
  forwardRef,
  useCallback,
  useEffect,
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
import type { UpdateBrush } from "@visx/brush/lib/BaseBrush";
import type { Bounds } from "@visx/brush/lib/types";
import { Line, AreaClosed } from "@visx/shape";
import { curveMonotoneX } from "@visx/curve";
import { localPoint } from "@visx/event";
import { decimate } from "./decimate";
import { volumeBarAt } from "./volume-bars";
import { AXIS_NUM_TICKS, axisMargin } from "./axis-margin";
import { useChartScales, valueAxisLabels } from "./use-chart-scales";
import { normalizeToPercentChange } from "./indicators";
import { layoutLevels } from "./chart-levels";
import {
  buildLatestReadout,
  buildMeasureReadout,
  buildPointReadout,
  readoutDayKey,
  readoutStripHeight,
  resolveReadoutMode,
  volumeReading,
  widestValueChars,
  type ReadoutDelta,
  type ReadoutEntry,
  type ReadoutFormat,
} from "./chart-readout";
import { ChartReadoutStrip, pinnedAnnouncement } from "./chart-readout-strip";
import { chartTheme } from "./chart-theme";
import {
  Axes,
  Crosshair,
  Grid,
  IndicatorPath,
  SeriesPath,
  VolumePath,
} from "./chart-primitives";
import {
  PIN_TOLERANCE_PX,
  TooltipContent,
  stepIndex,
  useChartPointer,
} from "./chart-tooltip";
import { useCoarsePointer } from "~/@/hooks/use-coarse-pointer";
import type {
  ChartBand,
  ChartLevel,
  ChartMarker,
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
// Under this many px a side is not a space a chart can be drawn in: StockChartInner
// draws nothing for a narrower width, and StockChart nothing for a lower
// measured height (the first measurement, before layout, is 0).
const MIN_DRAWABLE_PX = 10;
// Min horizontal drag (px) before a press is treated as a measure/zoom gesture
// rather than a click — below this we leave the view untouched.
const MEASURE_MIN_PX = 6;
// A touch that moves less than this between press and lift is a TAP (used to
// tell a re-tap on the pinned crosshair, which releases it, from a scrub).
const TAP_MAX_MOVE_PX = 6;
// Mobile browsers replay a tap as mousemove/mousedown/mouseup/click ~0-300ms
// after touchend. Mouse events this soon after a touch are those replays, not a
// real mouse: ignore them, or the replayed mousedown would start a measure
// gesture (and drop the pin) on every tap.
const TOUCH_MOUSE_GUARD_MS = 800;
// Width of the hover/pinned tooltip.
const TIP_W = 168;
// What an omitted `levels`, `bands` or `markers` defaults to: one shared, frozen
// array each. A fresh `[]` per render is a new identity every time, which would
// recompute the `reference` memo on every render of every chart, levels or not.
const NO_LEVELS: readonly ChartLevel[] = Object.freeze([]);
const NO_BANDS: readonly ChartBand[] = Object.freeze([]);
const NO_MARKERS: readonly ChartMarker[] = Object.freeze([]);
// The tooltip shows the reading, so no strip needs the room of a value.
const NO_VALUE_CHARS: Readonly<Record<string, number>> = Object.freeze({});

// What a screen reader is told about the chart, and how to drive it.
const CHART_LABEL =
  "Chart. Use the left and right arrow keys to step through readings, Escape to release.";

function normalizePoints(points: ChartPoint[]): ChartPoint[] {
  if (!points.length) return points;
  const norm = normalizeToPercentChange(points.map((p) => p.v));
  return points.map((p, i) => ({ t: p.t, v: norm[i] ?? 0 }));
}

/**
 * The points the brush band draws: the series that spans the most time (the
 * first of equals), alone. Series in different units cannot share one line:
 * merged, a price and a short position alternate day by day and draw a comb.
 */
export function brushOverviewPoints(series: ChartSeriesSpec[]): ChartPoint[] {
  let best: ChartPoint[] = [];
  let bestSpan = -1;
  for (const s of series) {
    const a = s.points[0];
    const b = s.points[s.points.length - 1];
    if (!a || !b) continue;
    if (b.t - a.t > bestSpan) {
      bestSpan = b.t - a.t;
      best = s.points;
    }
  }
  return best;
}

/** Exported for tests only — use `StockChart` (sized by ParentSize) in app code. */
export function StockChartInner({
  width,
  height,
  series,
  volume,
  indicators = [],
  oscillators = [],
  regions = [],
  levels = NO_LEVELS,
  bands = NO_BANDS,
  markers = NO_MARKERS,
  leftAxis,
  rightAxis,
  viewMode = "absolute",
  showBrush = true,
  variant = "full",
  decimationTargetPerPx = 2,
  readout = "strip",
  readoutReserveSeries,
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

  const isMobile = width > 0 && width <= MOBILE_MAX;
  const compact = variant === "compact";
  const hasRight = series.some((s) => s.axis === "right");

  // The room beside the plot. A side with an axis gets the room of the widest
  // label it prints (axisMargin): the tick and the label's offset from it (10px),
  // then the label, 6px a character in the 10px mono face. Six characters
  // ("$40.00", short interest as "12.00%") fit the 48px every side has; a price
  // of $100 or more is seven and takes 53, because the svg clips what falls
  // outside it. The labels are worked out from the data and the axis' format,
  // never measured: the margin sets the plot's width, and there is no plot to
  // measure until it is set.
  //
  // They are worked out from the series as the axis will draw them (inside the
  // zoom, and as percent change in the normalised view) but not decimated: the
  // plot's width sizes the decimation, so it comes after. Decimation keeps the
  // first and last points and the extremes, so the domain, and its labels, are
  // the same either way.
  //
  // With no right axis there is nothing beside the plot on the right but the time
  // axis' last label, which is centred on its tick: when that tick is the newest
  // day, half of it hangs past the plot, 21px for "October" and 27px for
  // "September", the longest. The svg clips what is outside it, and 12px cut
  // "October" to "Octobe" on the Short interest tab, which opens on this view.
  // A compact chart keeps its narrow margins: it is small, and its axes a hint.
  const leftHard = leftAxis?.domain;
  const leftFormat = leftAxis?.format;
  const rightHard = rightAxis?.domain;
  const rightFormat = rightAxis?.format;
  const marginsFor = useCallback(
    (range: [number, number] | null) => {
      if (compact) return { left: 32, right: 12 };
      const axisSeries = series.map((s) => {
        const inRange = range
          ? s.points.filter((p) => p.t >= range[0] && p.t <= range[1])
          : s.points;
        return {
          ...s,
          points: viewMode === "normalized" ? normalizePoints(inRange) : inRange,
        };
      });
      const labels = (
        side: "left" | "right",
        hard: typeof leftHard,
        format: typeof leftFormat,
      ) =>
        valueAxisLabels({
          series: axisSeries,
          side,
          hard,
          format,
          numTicks: AXIS_NUM_TICKS,
        });
      return {
        left: axisMargin(labels("left", leftHard, leftFormat)),
        right: hasRight
          ? axisMargin(labels("right", rightHard, rightFormat))
          : 28,
      };
    },
    [compact, series, viewMode, hasRight, leftHard, leftFormat, rightHard, rightFormat],
  );
  // What the whole series needs: a new object exactly when the data, the view
  // or an axis changes, never on a zoom.
  const wholeMargins = useMemo(() => marginsFor(null), [marginsFor]);
  const zoomMargins = useMemo(
    () => (filtered ? marginsFor(filtered) : wholeMargins),
    [marginsFor, filtered, wholeMargins],
  );
  // A zoom never narrows a side. A zoom whose widest label is a character
  // shorter than the last view's ("$140.00" to "$48.55") would take 5px back
  // and move the plot's left edge under the pointer, and a brush dragged across
  // that boundary would move it on every step. So a side is never narrower
  // than the whole series needs, nor than the widest any zoom has needed since
  // the data last changed. A zoom wider than that still grows it (the
  // normalised view prints percentages of the first point on screen); new data,
  // a new view or a new axis starts it over. The widest so far is state, raised
  // here during render when a zoom grows a side: React renders again at once,
  // before anything paints.
  const [heldMargins, setHeldMargins] = useState<{
    of: typeof wholeMargins | null;
    left: number;
    right: number;
  }>({ of: null, left: 0, right: 0 });
  const floor = heldMargins.of === wholeMargins ? heldMargins : wholeMargins;
  const leftMargin = Math.max(zoomMargins.left, floor.left);
  const rightMargin = Math.max(zoomMargins.right, floor.right);
  if (leftMargin > floor.left || rightMargin > floor.right) {
    setHeldMargins({ of: wholeMargins, left: leftMargin, right: rightMargin });
  }
  const margin = useMemo(
    () => ({ top: 8, right: rightMargin, bottom: 24, left: leftMargin }),
    [leftMargin, rightMargin],
  );

  const showVolume = !!volume?.length && !compact && !isMobile;
  const showOsc = oscillators.length > 0 && !compact;
  const showBrushBand = showBrush && !compact && !isMobile && width > 0;

  const brushH = showBrushBand ? 56 : 0;
  const oscH = showOsc ? 84 : 0;
  const innerW = Math.max(0, width - margin.left - margin.right);
  // Where the reading goes. The strip sits above the svg with a height that
  // depends on `width` and on how many series it shows (a phone strip has a row
  // for each) and on nothing a reading says, so the plot never moves when a
  // reading changes. It gives way to the floating tooltip when the plot left
  // under it would be too short to read. `height` stays the component's total
  // either way: the svg gets what the strip leaves.
  //
  // The rows it is sized for are the series it has, or the series it is told to
  // expect if that is more (`readoutReserveSeries`): a series that lands later
  // finds its row held, so the strip does not grow and the plot does not move.
  const heldSeries =
    Number.isInteger(readoutReserveSeries) && readoutReserveSeries! > 0
      ? readoutReserveSeries!
      : 0;
  const seriesCount = Math.max(series.length, heldSeries);
  const readoutMode = resolveReadoutMode({
    requested: readout,
    width,
    height,
    seriesCount,
    reservedH: margin.top + margin.bottom + brushH + oscH,
  });
  const stripH =
    readoutMode === "strip" ? readoutStripHeight(width, seriesCount) : 0;
  const svgH = height - stripH;
  const mainH = Math.max(0, svgH - margin.top - margin.bottom - brushH - oscH);

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

  // The volume on screen, raw: what a reading names and the highlight marks.
  // Undefined when the chart draws none, which keeps volume out of the readout.
  const rangeVolume = useMemo(() => {
    if (!showVolume || !volume) return undefined;
    return filtered
      ? volume.filter((p) => p.t >= filtered[0] && p.t <= filtered[1])
      : volume;
  }, [showVolume, volume, filtered]);

  // Volume scale: bottom ~28% of the main panel. The bars are drawn from a
  // decimated set; a reading never is (it could drop the session it names).
  // The extremes are kept: the busiest session is always drawn, and the scale's
  // top is the raw maximum, so a highlighted bar never rises out of the band.
  const decVolume = useMemo(() => {
    if (!rangeVolume) return [] as ChartPoint[];
    return decimate(rangeVolume, Math.max(innerW * decimationTargetPerPx, 2), {
      keepExtrema: true,
    }).points;
  }, [rangeVolume, innerW, decimationTargetPerPx]);

  const volumeScale = useMemo(() => {
    const maxV = decVolume.reduce((m, p) => Math.max(m, p.v), 0) || 1;
    return scaleLinear<number>({
      domain: [0, maxV],
      range: [mainH, mainH * 0.72],
    });
  }, [decVolume, mainH]);

  // Reference geometry (strategy levels): pure, clipped to the plot, recomputed
  // only when the scales change or a caller passes new arrays (an omitted prop is
  // a shared constant, so a chart without levels never recomputes it). A scale
  // answers undefined for a value it cannot place (NaN): that stays NaN, so the
  // layout drops it, where `?? 0` would draw it on the plot's top or left edge.
  // Nothing here is hoverable.
  const reference = useMemo(
    () =>
      layoutLevels({
        levels,
        bands,
        markers,
        x: (t) => dateScale(t) ?? NaN,
        yFor: (axis) => (v) => scaleForAxis(axis)(v) ?? NaN,
        innerW,
        innerH: mainH,
      }),
    [levels, bands, markers, dateScale, scaleForAxis, innerW, mainH],
  );

  const {
    pinned,
    active,
    isPinnedView,
    onMove,
    onLeave,
    hoverAtX,
    pin,
    unpin,
    pinAtTime,
  } = useChartPointer({
    xScale: dateScale,
    series: renderSeries,
    marginLeft: margin.left,
  });
  const coarsePointer = useCoarsePointer();
  const containerRef = useRef<HTMLDivElement | null>(null);
  // The rect that captures the pointer over the plot: a release is "on the plot"
  // when it is the event's target.
  const plotRef = useRef<SVGRectElement | null>(null);
  // Release from the strip's button, then hand focus back to the chart: the
  // button is about to unmount, and focus on a removed node falls to <body>.
  // No scroll: the chart is already where the user is looking.
  const releasePin = useCallback(() => {
    unpin();
    containerRef.current?.focus({ preventScroll: true });
  }, [unpin]);

  // ── Drag-to-measure + zoom ────────────────────────────────────────────────
  // Press-drag horizontally across the plot: a shaded region tracks the cursor
  // and reports each visible series' point-to-point change; release zooms into
  // that range (double-click resets). x0/x1 are inner-plot px (0..innerW).
  const [measure, setMeasure] = useState<{ x0: number; x1: number } | null>(
    null,
  );
  // Mirror of `measure` for the window mouseup listener, which is bound once per
  // gesture and must read the latest endpoint without re-subscribing per move.
  const measureRef = useRef<{ x0: number; x1: number } | null>(null);
  const setMeasureBoth = useCallback(
    (m: { x0: number; x1: number } | null) => {
      measureRef.current = m;
      setMeasure(m);
    },
    [],
  );

  const innerXFromEvent = useCallback(
    (
      e:
        | React.MouseEvent<SVGRectElement>
        | React.TouchEvent<SVGRectElement>
        | MouseEvent,
    ): number | null => {
      const pt = localPoint(e);
      if (!pt) return null;
      return Math.max(0, Math.min(innerW, pt.x - margin.left));
    },
    [innerW, margin.left],
  );

  // Latest-value refs so the (stable) commit reads the CURRENT scales at
  // release time — never a closure captured when the gesture began (which would
  // misfire if the chart reflowed/resized mid-drag). Kept current by an effect
  // declared below, once `brushDateScale` exists.
  const dateScaleRef = useRef(dateScale);
  const brushDateScaleRef = useRef<ReturnType<typeof scaleTime<number>> | null>(
    null,
  );

  // A click does not zoom, and the press that began it dropped the hover (a
  // measure was starting), so without this the strip would sit on its resting
  // reading until the pointer next moved. In strip mode, read the point under
  // the release instead: the pointer is there. Only when the release IS on the
  // plot. Let go anywhere else (off the plot, over the strip, over another
  // chart) and there is no pointer here to read, and a hover would hang on a
  // crosshair nothing will ever clear. The tooltip mode keeps its card hidden
  // until the next move, as it always has.
  const hoverAtRelease = useCallback(
    (ev: MouseEvent) => {
      if (ev.target !== plotRef.current) return;
      const pt = localPoint(ev);
      if (!pt) return;
      hoverAtX(Math.max(0, Math.min(innerW, pt.x - margin.left)), pt.y);
    },
    [hoverAtX, innerW, margin.left],
  );

  const commitMeasure = useCallback((release?: MouseEvent) => {
    const m = measureRef.current;
    setMeasureBoth(null);
    if (!m) return;
    // Whatever ends without a zoom is a click as far as the reading goes.
    const endsWithoutZoom = () => {
      if (readoutMode === "strip" && release) hoverAtRelease(release);
    };
    if (Math.abs(m.x1 - m.x0) < MEASURE_MIN_PX) return endsWithoutZoom(); // a click, not a drag
    const ds = dateScaleRef.current;
    const xa = Math.min(m.x0, m.x1);
    const xb = Math.max(m.x0, m.x1);
    const ta = ds.invert(xa).getTime();
    const tb = ds.invert(xb).getTime();
    if (tb - ta < 1) return endsWithoutZoom();
    setFiltered([ta, tb]);
    // Mirror the zoom in the overview brush band so the two stay in sync (the
    // band always spans the full dataset, so map through its own scale).
    const b = brushRef.current;
    const bds = brushDateScaleRef.current;
    if (b && bds) {
      const updater: UpdateBrush = (prev) => {
        const ext = b.getExtent({ x: bds(new Date(ta)) }, { x: bds(new Date(tb)) });
        return {
          ...prev,
          start: { y: ext.y0, x: ext.x0 },
          end: { y: ext.y1, x: ext.x1 },
          extent: ext,
        };
      };
      b.updateBrush(updater);
    }
  }, [setMeasureBoth, setFiltered, readoutMode, hoverAtRelease]);

  const resetView = useCallback(() => {
    unpin();
    setMeasureBoth(null);
    brushRef.current?.reset();
    setFiltered(null);
    // The click that began this double-click read the point under it (strip
    // mode, above), against the zoom this resets: that reading, and its
    // crosshair, belong to a view that is gone. The next move reads the new one.
    if (readoutMode === "strip") onLeave();
  }, [setMeasureBoth, unpin, readoutMode, onLeave]);

  // ── Touch: scrub to read, lift to pin, re-tap the pin to release ─────────
  // A hover cleared on touchend vanished the moment the finger lifted, so a
  // phone user could never read it. Lifting now PINS the reading.
  const lastTouchAt = useRef(0);
  const touchGesture = useRef<{
    startX: number;
    lastX: number;
    onPin: boolean;
  } | null>(null);
  const isTouchReplay = useCallback(
    () => Date.now() - lastTouchAt.current < TOUCH_MOUSE_GUARD_MS,
    [],
  );

  const onPlotTouchStart = useCallback(
    (e: React.TouchEvent<SVGRectElement>) => {
      lastTouchAt.current = Date.now();
      if (e.touches.length > 1) {
        // Pinch: not ours to read. Drop the live reading, keep any pin.
        touchGesture.current = null;
        onLeave();
        return;
      }
      const pt = localPoint(e);
      if (!pt) return;
      const x = pt.x - margin.left;
      touchGesture.current = {
        startX: x,
        lastX: x,
        onPin: !!pinned && Math.abs(pinned.cx - x) <= PIN_TOLERANCE_PX,
      };
      onMove(e); // a tap shows the crosshair without needing any movement
    },
    [margin.left, onLeave, onMove, pinned],
  );

  const onPlotTouchMove = useCallback(
    (e: React.TouchEvent<SVGRectElement>) => {
      lastTouchAt.current = Date.now();
      const g = touchGesture.current;
      if (!g) return;
      const pt = localPoint(e);
      if (pt) g.lastX = pt.x - margin.left;
      onMove(e);
    },
    [margin.left, onMove],
  );

  const onPlotTouchEnd = useCallback(() => {
    lastTouchAt.current = Date.now();
    const g = touchGesture.current;
    touchGesture.current = null;
    if (g?.onPin && Math.abs(g.lastX - g.startX) < TAP_MAX_MOVE_PX) {
      unpin(); // re-tap on the pinned crosshair releases it
    } else if (g) {
      pin(); // lock the current reading so it survives the lift
    }
    onLeave();
  }, [onLeave, pin, unpin]);

  const onPlotTouchCancel = useCallback(() => {
    lastTouchAt.current = Date.now();
    touchGesture.current = null;
    onLeave(); // scroll took over: drop the live reading, keep the pin
  }, [onLeave]);

  // Release the pin on a press anywhere outside the chart. Registered only
  // while pinned so idle charts add no document listeners.
  const hasPin = pinned !== null;
  useEffect(() => {
    if (!hasPin) return;
    const onDocPress = (ev: Event) => {
      const el = containerRef.current;
      if (el && ev.target instanceof Node && el.contains(ev.target)) return;
      unpin();
    };
    document.addEventListener("mousedown", onDocPress);
    document.addEventListener("touchstart", onDocPress, { passive: true });
    return () => {
      document.removeEventListener("mousedown", onDocPress);
      document.removeEventListener("touchstart", onDocPress);
    };
  }, [hasPin, unpin]);

  const onPlotMouseDown = useCallback(
    (e: React.MouseEvent<SVGRectElement>) => {
      if (e.button !== 0) return; // left button only
      // The 2nd click of a double-click would otherwise start (and the 2nd
      // mouseup commit) a stray zoom right before onDoubleClick resets it.
      if (e.detail > 1) return;
      if (isTouchReplay()) return; // a tap's synthetic mousedown, not a drag
      const x = innerXFromEvent(e);
      if (x == null) return;
      onLeave(); // drop the hover crosshair while measuring
      unpin();
      setMeasureBoth({ x0: x, x1: x });
    },
    [innerXFromEvent, isTouchReplay, onLeave, setMeasureBoth, unpin],
  );

  const onPlotMouseMove = useCallback(
    (e: React.MouseEvent<SVGRectElement>) => {
      if (isTouchReplay()) return; // a tap's synthetic mousemove
      if (measureRef.current) {
        const x = innerXFromEvent(e);
        if (x != null) setMeasureBoth({ x0: measureRef.current.x0, x1: x });
        return;
      }
      onMove(e);
    },
    [innerXFromEvent, isTouchReplay, onMove, setMeasureBoth],
  );

  const onPlotMouseLeave = useCallback(() => {
    // Keep the selection alive while dragging outside the plot; the window
    // mouseup listener commits it. Only clear the hover when not measuring.
    if (!measureRef.current) onLeave();
  }, [onLeave]);

  // Commit on release anywhere (handles the cursor leaving the plot mid-drag).
  // Keyed on the boolean so it re-subscribes only when a gesture starts/ends,
  // not on every pointer move; commitMeasure reads the latest endpoint via ref.
  const dragging = measure !== null;
  useEffect(() => {
    if (!dragging) return;
    const onUp = (ev: MouseEvent) => commitMeasure(ev);
    window.addEventListener("mouseup", onUp);
    return () => window.removeEventListener("mouseup", onUp);
  }, [dragging, commitMeasure]);

  // Live readout: each visible series' change between the two endpoints. Skip
  // sub-pixel selections so a plain click never flashes a "+0.0%" panel. One
  // model feeds both homes of the reading, the strip and the floating card, so
  // they cannot disagree about a date, a number, a sign or a colour. That
  // includes the card's dates: en-AU on the Sydney calendar (spec D5, Dates),
  // where the card once printed them in the browser's locale. The hover card
  // dates its reading the same way: TooltipContent takes formatReadoutDate too.
  const measureInfo = useMemo(() => {
    if (!measure || Math.abs(measure.x1 - measure.x0) < 1) return null;
    const xa = Math.min(measure.x0, measure.x1);
    const xb = Math.max(measure.x0, measure.x1);
    const ta = dateScale.invert(xa).getTime();
    const tb = dateScale.invert(xb).getTime();
    const model = buildMeasureReadout({ series: renderSeries, ta, tb });
    return { xa, xb, ta, tb, model };
  }, [measure, renderSeries, dateScale]);

  // The floating card lists the series that have a change to show.
  const measureRows = useMemo(
    () =>
      measureInfo
        ? measureInfo.model.entries.filter(
            (e): e is ReadoutEntry & { change: ReadoutDelta } => e.change !== null,
          )
        : [],
    [measureInfo],
  );

  // ── The readout (spec D5) ──────────────────────────────────────────────────
  // One format function for every number in the strip: the per-axis formatters
  // TooltipContent uses, so both homes of a reading agree to the digit.
  const readoutFormat = useCallback<ReadoutFormat>(
    (s, v) => {
      const f = s.axis === "right" ? rightFormat : leftFormat;
      return f ? f(v) : v.toFixed(2);
    },
    [leftFormat, rightFormat],
  );

  // The resting reading. It depends on the rendered series, the formats, the
  // view and the zoom only, so a hover on a quiet chart does not rebuild it.
  // Not built at all when the tooltip shows the reading.
  const latestModel = useMemo(
    () =>
      readoutMode === "strip"
        ? buildLatestReadout({
            series: renderSeries,
            zoomed: filtered !== null,
            viewMode,
            format: readoutFormat,
            volume: rangeVolume,
          })
        : null,
    [readoutMode, renderSeries, filtered, viewMode, readoutFormat, rangeVolume],
  );

  // The room each series' value keeps on one row: that of the widest it can show
  // among the points on screen, so a scrub across a digit boundary shifts
  // nothing. Two numbers formatted per series, and only when the strip is shown.
  const valueChars = useMemo(
    () =>
      readoutMode === "strip"
        ? widestValueChars(renderSeries, readoutFormat)
        : NO_VALUE_CHARS,
    [readoutMode, renderSeries, readoutFormat],
  );

  // What the strip shows now. A measure takes it over, as it took over the
  // tooltip; a sub-pixel measure shows the resting reading, not a stale hover.
  const readoutModel = useMemo(() => {
    if (readoutMode !== "strip") return null;
    if (measure) return measureInfo?.model ?? latestModel;
    if (active) {
      return buildPointReadout({
        series: renderSeries,
        entries: active.entries,
        pinned: isPinnedView,
        format: readoutFormat,
        volume: rangeVolume,
      });
    }
    return latestModel;
  }, [
    readoutMode,
    measure,
    measureInfo,
    active,
    isPinnedView,
    renderSeries,
    readoutFormat,
    rangeVolume,
    latestModel,
  ]);

  // The time of the session being read: the first series' point, as the
  // readout's headline dates it.
  const activeT = active?.entries[0]?.point.t ?? null;

  // The bar under the reading (hover, pin or key step), measured on the raw
  // volume so it is the session the readout names. None while measuring.
  const activeVolumeBar = useMemo(
    () =>
      rangeVolume && activeT !== null && !measure
        ? volumeBarAt(rangeVolume, activeT, {
            x: (t) => dateScale(new Date(t)) ?? 0,
            y: (v) => volumeScale(v) ?? 0,
            baseline: volumeScale(0) ?? 0,
            width: innerW,
          })
        : null,
    [rangeVolume, activeT, measure, dateScale, volumeScale, innerW],
  );

  // The hover card's volume row: the same reading the strip would show.
  const tooltipVolume = useMemo(
    () =>
      readoutMode === "tooltip" && activeT !== null
        ? volumeReading(rangeVolume, activeT, readoutDayKey(activeT))
        : null,
    [readoutMode, rangeVolume, activeT],
  );

  // The announcer speaks when a reading is pinned and when it is released, in
  // both modes, and never while one is scrubbed (a scrub is not a pin). Keyed on
  // the sentence, so a resize, which re-derives the pin's x, says nothing.
  const pinnedEntries = pinned?.entries ?? null;
  const pinSentence = useMemo(
    () =>
      pinnedEntries
        ? pinnedAnnouncement(
            buildPointReadout({
              series: renderSeries,
              entries: pinnedEntries,
              pinned: true,
              format: readoutFormat,
              volume: rangeVolume,
            }),
          )
        : null,
    [pinnedEntries, renderSeries, readoutFormat, rangeVolume],
  );
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    setAnnouncement((prev) => pinSentence ?? (prev ? "Reading released" : ""));
  }, [pinSentence]);

  // Keyboard: the arrow keys step a pinned reading through the points of the
  // series with the most rendered points (the first of equals), Home and End
  // jump to the ends, and Escape releases.
  const stepPoints = useMemo(() => {
    let best: ChartPoint[] = [];
    for (const s of renderSeries) {
      if (s.points.length > best.length) best = s.points;
    }
    return best;
  }, [renderSeries]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      // Alt+Left is the browser's Back; leave every chord alone.
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
      if (e.key === "Escape") {
        // Nothing pinned: Escape is somebody else's, a dialog around the chart.
        if (!pinned) return;
        e.preventDefault();
        // Not a bare unpin: with focus on the release button, which this removes,
        // focus would fall to <body>.
        releasePin();
        return;
      }
      // A step starts from the reading on screen: the pin the keys (or a tap)
      // made, else the point under the pointer, else the end of the series. The
      // pin comes first because it is the keyboard's cursor once it has one, so a
      // pointer that wanders over the chart between two presses does not take it.
      const i = stepIndex(stepPoints, e.key, (pinned ?? active)?.t ?? null);
      const point = i === null ? undefined : stepPoints[i];
      if (!point) return;
      e.preventDefault();
      // A live mouse hover outranks a pin on screen, and a step is announced as
      // a pin: drop the hover, so what is said is what is shown. The pointer's
      // next move takes the screen back, as it does from any pin.
      onLeave();
      pinAtTime(point.t);
    },
    [pinned, active, onLeave, pinAtTime, releasePin, stepPoints],
  );

  // Brush overview: the shape of ONE series, the one spanning the most time
  // (`brushOverviewPoints`), hard-decimated. It once merged every series' points
  // into one line, and in the Combined view that zig-zagged between a $4 price
  // and a 9% short position on alternate days: a grey comb that read as volume.
  // The band and its selectable range still span every series' dates.
  const brushSeries = useMemo(
    () =>
      decimate(brushOverviewPoints(series), Math.max(Math.floor(innerW / 2), 2))
        .points,
    [series, innerW],
  );

  // Reduce loops (not Math.min(...arr) spread) — safe for any point count.
  const brushDomain = useMemo(() => {
    let tLo = Infinity;
    let tHi = -Infinity;
    let vLo = Infinity;
    let vHi = -Infinity;
    // Points are ascending, so each series' ends are its first and last.
    for (const s of series) {
      const a = s.points[0];
      const b = s.points[s.points.length - 1];
      if (a && a.t < tLo) tLo = a.t;
      if (b && b.t > tHi) tHi = b.t;
    }
    for (const p of brushSeries) {
      if (p.v < vLo) vLo = p.v;
      if (p.v > vHi) vHi = p.v;
    }
    if (!Number.isFinite(vLo)) {
      vLo = 0;
      vHi = 1;
    }
    if (!Number.isFinite(tLo)) {
      tLo = 0;
      tHi = 1;
      vLo = 0;
      vHi = 1;
    }
    return { tLo, tHi, vLo, vHi };
  }, [series, brushSeries]);

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

  // Keep the commit-time scale refs pointed at the live scales (see above).
  useEffect(() => {
    dateScaleRef.current = dateScale;
    brushDateScaleRef.current = brushDateScale;
  });

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
        unpin();
        brushRef.current?.reset();
        setFiltered(null);
      },
    }),
    [unpin],
  );

  if (width < MIN_DRAWABLE_PX) return null;

  const oscTop = margin.top + mainH + (showOsc ? 12 : 0);
  const brushTop = svgH - brushH + 4;

  return (
    // A keyboard-driven custom widget: the arrow keys step a reading through the
    // data, so the container takes a tab stop and key handlers (the roadmap tree
    // makes the same exception). A labelled group rather than an application, so
    // a screen reader can still read the strip inside it.
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <div
      ref={containerRef}
      data-chart-container
      role="group"
      aria-label={CHART_LABEL}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      style={{ position: "relative" }}
    >
      {/* Only in strip mode: readoutModel is null in tooltip mode. */}
      {readoutModel && (
        <ChartReadoutStrip
          model={readoutModel}
          width={width}
          height={stripH}
          pinned={isPinnedView}
          valueChars={valueChars}
          seriesRows={seriesCount}
          onRelease={releasePin}
        />
      )}
      <svg
        width={width}
        height={svgH}
        data-points={renderSeries[0]?.points.length ?? 0}
        // An inline svg sits on the text baseline and leaves a few px under it;
        // with a strip above, the two must add up to exactly `height`.
        style={readoutMode === "strip" ? { display: "block" } : undefined}
      >
        <Group left={margin.left} top={margin.top}>
          <Grid yScale={leftScale} width={innerW} />
          {/* Divergence bands sit UNDER the data: short-vs-price regimes. */}
          {regions.map((r, i) => {
            const xa = dateScale(r.start);
            const xb = dateScale(r.end);
            const x = Math.max(0, Math.min(xa, xb));
            const cw = Math.min(Math.max(xa, xb), innerW) - x;
            if (cw <= 0) return null;
            return (
              <rect
                key={`region-${i}`}
                x={x}
                y={0}
                width={cw}
                height={mainH}
                fill={r.tone === "bearish" ? "#ef4444" : "#22c55e"}
                fillOpacity={0.1}
                pointerEvents="none"
              >
                {r.label ? <title>{r.label}</title> : null}
              </rect>
            );
          })}
          {reference.bands.map((b, i) => (
            <rect
              key={`band-${i}`}
              data-chart-band
              x={b.x}
              y={b.y}
              width={b.width}
              height={b.height}
              fill={b.color}
              fillOpacity={0.12}
              pointerEvents="none"
            >
              {b.label ? <title>{b.label}</title> : null}
            </rect>
          ))}
          {showVolume && (
            <VolumePath
              data={decVolume}
              xScale={dateScale}
              yScale={volumeScale}
              width={innerW}
            />
          )}
          {/* The bar of the session being read, so the reading's Vol figure
              points at the bar it names. */}
          {activeVolumeBar && (
            <rect
              data-chart="volume-active"
              x={activeVolumeBar.x}
              y={activeVolumeBar.y}
              width={activeVolumeBar.width}
              height={activeVolumeBar.height}
              fill={chartTheme.volume}
              fillOpacity={chartTheme.volumeActiveOpacity}
              pointerEvents="none"
            />
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
          {reference.levels.map((l, i) => (
            <Group key={`level-${i}`} data-chart-level pointerEvents="none">
              <Line
                from={{ x: l.x1, y: l.y }}
                to={{ x: l.x2, y: l.y }}
                stroke={l.color}
                strokeWidth={1}
                strokeDasharray={l.dash}
              />
              <text
                x={l.labelX}
                y={l.labelY}
                textAnchor="end"
                fontSize={10}
                fill={l.color}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {l.label}
              </text>
            </Group>
          ))}
          {reference.markers.map((m, i) => (
            <Group key={`marker-${i}`} data-chart-marker pointerEvents="none">
              <Line
                from={{ x: m.x, y: 0 }}
                to={{ x: m.x, y: mainH }}
                stroke={m.color}
                strokeWidth={1}
                strokeDasharray="2,3"
              />
              <text
                x={m.labelX}
                y={10}
                textAnchor={m.labelAnchor}
                fontSize={10}
                fill={m.color}
              >
                {m.label}
              </text>
            </Group>
          ))}
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
          {/* Drag-measure shaded region + endpoints (suppresses the crosshair). */}
          {measureInfo ? (
            <g pointerEvents="none" data-chart="measure">
              <rect
                x={measureInfo.xa}
                y={0}
                width={Math.max(measureInfo.xb - measureInfo.xa, 0)}
                height={mainH}
                fill="hsl(var(--primary))"
                fillOpacity={0.1}
              />
              {[measureInfo.xa, measureInfo.xb].map((x, i) => (
                <Line
                  key={i}
                  from={{ x, y: 0 }}
                  to={{ x, y: mainH }}
                  stroke="hsl(var(--primary))"
                  strokeOpacity={0.55}
                  strokeWidth={1}
                  strokeDasharray="3,3"
                />
              ))}
            </g>
          ) : (
            active && (
              <Crosshair
                x={active.cx}
                innerH={mainH}
                dots={active.entries.map((e) => ({
                  y: scaleForAxis(e.series.axis)(e.point.v) ?? 0,
                  color: e.series.color,
                }))}
              />
            )
          )}
          {/* pointer capture — drag to measure + zoom, double-click to reset;
              touch: scrub to read, lift to pin, re-tap to release. pan-y keeps
              vertical page scroll; a horizontal finger move scrubs. (React
              touch listeners are passive, so CSS is the only lever here.) */}
          <rect
            ref={plotRef}
            x={0}
            y={0}
            width={innerW}
            height={mainH}
            fill="transparent"
            data-chart-capture
            style={{ cursor: "crosshair", touchAction: "pan-y" }}
            onMouseDown={onPlotMouseDown}
            onMouseMove={onPlotMouseMove}
            onMouseLeave={onPlotMouseLeave}
            onTouchStart={onPlotTouchStart}
            onTouchMove={onPlotTouchMove}
            onTouchEnd={onPlotTouchEnd}
            onTouchCancel={onPlotTouchCancel}
            onDoubleClick={resetView}
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

      {readoutMode === "tooltip" &&
        active &&
        !measure &&
        (() => {
          // Coordinates are relative to this relative wrapper — no portal /
          // viewport math (which mis-measured on scrolled, sticky-header pages).
          //
          // Fine pointer: follow the cursor. Finger (coarse pointer, or any
          // touch-driven reading): DOCK in the top corner on the side away from
          // the crosshair — next to the finger it sits under the thumb.
          const docked =
            coarsePointer ||
            active.source === "touch" ||
            active.source === "keyboard";
          let left: number;
          let top: number;
          if (docked) {
            top = margin.top + 4;
            left =
              active.cx < innerW / 2
                ? Math.max(4, width - TIP_W - 4)
                : margin.left + 4;
          } else {
            const TIP_H = 120;
            const anchorX = active.cx + margin.left;
            const anchorY = active.cy;
            left =
              anchorX + 14 + TIP_W <= width
                ? anchorX + 14
                : Math.max(4, anchorX - 14 - TIP_W);
            top = Math.min(
              Math.max(4, anchorY + 14),
              Math.max(4, height - TIP_H),
            );
          }
          return (
            <div
              data-chart-tooltip
              data-pinned={isPinnedView ? "" : undefined}
              data-docked={docked ? "" : undefined}
              role={isPinnedView ? "status" : undefined}
              style={{
                position: "absolute",
                left,
                top,
                ...(docked ? { width: TIP_W } : {}),
                maxWidth: TIP_W,
                background: chartTheme.tooltipBg,
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                padding: isPinnedView ? "8px 30px 8px 10px" : "8px 10px",
                boxShadow: "0 4px 12px hsl(var(--foreground) / 0.1)",
                // A pinned card is interactive (its release button); a live
                // hover must never steal the pointer from the plot.
                pointerEvents: isPinnedView ? "auto" : "none",
                zIndex: 20,
              }}
            >
              <TooltipContent
                hover={active}
                leftAxis={leftAxis}
                rightAxis={rightAxis}
                volume={tooltipVolume}
              />
              {isPinnedView && (
                <>
                  <div
                    style={{
                      color: chartTheme.tooltipFg,
                      opacity: 0.55,
                      fontSize: 10,
                      marginTop: 4,
                    }}
                  >
                    Pinned · tap chart to move, tap again to release
                  </div>
                  <button
                    type="button"
                    aria-label="Release pinned reading"
                    onClick={unpin}
                    style={{
                      position: "absolute",
                      top: 0,
                      right: 0,
                      width: 32,
                      height: 32,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      border: "none",
                      padding: 0,
                      cursor: "pointer",
                      color: chartTheme.tooltipFg,
                      opacity: 0.6,
                      fontSize: 14,
                      lineHeight: 1,
                    }}
                  >
                    ×
                  </button>
                </>
              )}
            </div>
          );
        })()}

      {readoutMode === "tooltip" &&
        measureInfo &&
        measureRows.length > 0 &&
        (() => {
          // Inline (no portal) — same scrolled-page-safe positioning as the
          // hover tooltip, anchored to the right edge of the measured range.
          const TIP_W = 188;
          const anchorX = measureInfo.xb + margin.left;
          const left =
            anchorX + 14 + TIP_W <= width
              ? anchorX + 14
              : Math.max(4, anchorX - 14 - TIP_W);
          return (
            <div
              data-chart="measure-readout"
              style={{
                position: "absolute",
                left,
                top: margin.top + 8,
                maxWidth: TIP_W,
                background: chartTheme.tooltipBg,
                border: "1px solid hsl(var(--border))",
                borderRadius: 8,
                padding: "8px 10px",
                boxShadow: "0 4px 12px hsl(var(--foreground) / 0.1)",
                pointerEvents: "none",
                zIndex: 20,
                color: chartTheme.tooltipFg,
                fontSize: 12,
                lineHeight: 1.4,
              }}
            >
              <div style={{ opacity: 0.7, marginBottom: 4 }}>
                {measureInfo.model.headline}
              </div>
              {measureRows.map((r) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    marginBottom: 2,
                  }}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 9999,
                      background: r.color,
                      display: "inline-block",
                    }}
                  />
                  <span style={{ opacity: 0.8 }}>{r.label}</span>
                  <span
                    style={{
                      marginLeft: "auto",
                      fontVariantNumeric: "tabular-nums",
                      fontWeight: 600,
                      // Red and green are market direction: a percentage-point
                      // change keeps the card's text colour.
                      color:
                        r.change.colored && r.change.tone === "up"
                          ? "#16a34a"
                          : r.change.colored && r.change.tone === "down"
                            ? "#dc2626"
                            : chartTheme.tooltipFg,
                    }}
                  >
                    {r.change.text}
                  </span>
                </div>
              ))}
            </div>
          );
        })()}

      {/* Persistent, so a change of its text is a change a screen reader hears. */}
      <div role="status" className="sr-only" data-chart-announcer>
        {announcement}
      </div>
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
    // A caller that passes a height owns it (the embed, the strategy chart, the
    // dashboard widgets). One that does not gets its parent's: the wrapper
    // fills the parent and the chart takes the height ParentSize measures, so a
    // box sized by CSS alone sizes the chart, across a breakpoint too. Either
    // way that height is the chart's total, and the readout strip and the mode
    // choice work from it. The parent needs a definite height; over an auto one
    // `100%` is auto, and the wrapper measures its own content, which is
    // nothing until the chart has drawn.
    const fixed = props.height;
    return (
      <div style={{ width: "100%", height: fixed ?? "100%" }}>
        <ParentSize>
          {({ width, height: measured }) => {
            const height = fixed ?? measured;
            // Nothing to draw into yet: the bar StockChartInner holds the width
            // to. A height the caller gave is theirs to get right.
            if (fixed === undefined && height < MIN_DRAWABLE_PX) return null;
            return (
              <StockChartInner {...props} width={width} height={height} handleRef={ref} />
            );
          }}
        </ParentSize>
      </div>
    );
  },
);

export default StockChart;
