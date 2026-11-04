"use client";

/**
 * The movement heatmap's island (spec 13.4): the brush over the week axis. The
 * server draws the default view into the HTML (movement-heatmap-static.tsx); this
 * island reads the link under its own Suspense boundary and draws the same grid for
 * the window the link names, with the brush over the desktop weeks.
 *
 * ONE STATE, THREE CONTROLS. The brush and the window chips write the same
 * parameters (`window`, or the brushed pair `since` and `until`, see window-chips.tsx),
 * so a brush that matches a chip writes the chip, and a chip sets the brush's
 * handles. A committed brush writes the link in place with `replaceState`, which
 * `useSearchParams` observes, so the flows (and the map, once it reads the pair)
 * follow it with no RSC request.
 *
 * THE BRUSH IS A POINTER CONTROL. Its handles are not focusable, so the keyboard
 * path to a window is the chips, and each cell's count is a link in the sr-only table.
 * A held brush moves only its own handles: the rows, the caption and the chips follow
 * the committed window until the pointer is released.
 *
 * THE LOADER REDRAWS THE CHIPS AND THE BRUSH. The server sends the last 52 weeks; a
 * link that moves the window asks `loadActivity` again, and the grid draws that page.
 */

import { Brush } from "@visx/brush";
import type { Bounds } from "@visx/brush/lib/types";
import { scaleLinear } from "@visx/scale";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { OwnershipActivityPage } from "~/app/actions/ownershipDesk";
import { SourceControl } from "./source-control";
import { KIND_ORDER, kindSelectLabel } from "~/@/lib/ownership/kinds";
import { parseSelection, serializeSelection } from "~/@/components/ownership/workspace/selection";
import { ViewDisclosure } from "../workspace/view-disclosure";
import { TOOLBAR_ROW_CLASS, ToolbarSelect, type ToolbarFold } from "../workspace/toolbar";
import { writeWindowInPlace } from "../workspace/window-select";

/** The island's phone fold of the toolbar (spec 14.9): the client disclosure around the row. */
const toolbarFold: ToolbarFold = (row) => <ViewDisclosure>{row}</ViewDisclosure>;
import { isIsoDate, shiftDate, type DeskWindow } from "./desk-state";
import {
  DESK_DEFAULT_WINDOW_STATE,
  chipForBrush,
  noticeWindowHref,
  readNoticeWindow,
  type NoticeWindow,
} from "./window-chips";
import {
  HEAT_FULL_CELL,
  MovementHeatmapView,
  type HeatMeasure,
  selectedWeekRange,
  weekList,
  weekTotals,
} from "./movement-heatmap-static";

/** The parameters that name the window: a selection's `sel` is not one of them. */
export function windowParamsKey(params: URLSearchParams): string {
  return ["window", "since", "until"].map((key) => params.get(key) ?? "").join("|");
}

/** One week's column in the brush, in the grid's own units: the desktop cell width. */
const WEEK_UNITS = HEAT_FULL_CELL;
const BRUSH_HEIGHT = 22;

export interface MovementHeatmapProps {
  /** The default view the server rendered: the last 52 weeks, no window. */
  initial: OwnershipActivityPage;
  /** The path the window chips and the brush write to. */
  basePath: string;
  /**
   * The activity loader (`loadOwnershipActivity`). A link that moves the window asks
   * it again, so the chips and the brush redraw from the loader's page; the grid keeps
   * the page it has until the new one arrives.
   */
  loadActivity?: (input: { weeks?: number; kind?: string }) => Promise<OwnershipActivityPage>;
  /**
   * `full` is the Activity page: the Notice count | Voting power change switch and the
   * Holder type control are drawn above the grid, and a cell selects for the inspector.
   * `compact` is the Overview's pane: the grid, as it is.
   */
  variant?: "compact" | "full";
}

/**
 * The brushed window for a span of weeks. The last week runs to the newest notice
 * read, not to its Sunday, so a window ending at the newest week is a window that
 * ends today. A span that equals a chip is written as the chip.
 */
export function brushWindow(
  first: number,
  last: number,
  weeks: readonly string[],
  asOf: string,
  days: DeskWindow,
): NoticeWindow | null {
  if (weeks.length === 0 || !isIsoDate(asOf)) return null;
  const lo = Math.max(0, Math.min(first, weeks.length - 1));
  const hi = Math.max(lo, Math.min(last, weeks.length - 1));
  const since = weeks[lo]!;
  const until = hi === weeks.length - 1 ? asOf : shiftDate(weeks[hi]!, 6);
  if (since > until) return null;
  const chip = chipForBrush(since, until, asOf);
  if (chip !== null) return { window: chip, since: "", until: "" };
  return { window: days, since, until };
}

/**
 * What a released brush writes, or null when it writes nothing. A release on the
 * span already committed (a click on the selected box, or a drag that ends where it
 * began) changes no window, so a chip stays a chip; visx ends every drag with a
 * release, so this is the common case, not the edge.
 */
export function brushCommit(
  first: number,
  last: number,
  committed: NoticeWindow,
  weeks: readonly string[],
  asOf: string,
  days: DeskWindow,
): NoticeWindow | null {
  const was = selectedWeekRange(committed, asOf, weeks);
  if (was !== null && was.first === first && was.last === last) return null;
  return brushWindow(first, last, weeks, asOf, days);
}

/**
 * visx widens every brush extent by SAFE_PIXEL (2 px) on each side before it inverts
 * it to the domain, so a span of weeks [first, last] reports as roughly
 * [first - 1/6, last + 1 + 1/6] at this width. The edge tolerance undoes that
 * widening and still rounds a pointer to the week it is in.
 */
const BRUSH_EDGE_WEEKS = 0.2;

/**
 * The weeks a brush covers, from its bounds. visx reports the bounds in DOMAIN units
 * (weeks, from the brush's xScale), never pixels, so a week is one unit wide. The span
 * is every week the brush touches, at least one.
 */
export function weeksUnderBrush(bounds: Pick<Bounds, "x0" | "x1">, count: number): { first: number; last: number } {
  const first = Math.floor(bounds.x0 + BRUSH_EDGE_WEEKS);
  const last = Math.ceil(bounds.x1 - BRUSH_EDGE_WEEKS) - 1;
  const clampedFirst = Math.max(0, Math.min(first, count - 1));
  return { first: clampedFirst, last: Math.max(clampedFirst, Math.min(last, count - 1)) };
}

interface WeekBrushProps {
  count: number;
  /** The notices released in each week, drawn as bars under the handles (spec 14.3). */
  totals: readonly number[];
  /** The committed window's weeks, which set the handles. Changing them remounts the brush. */
  first: number;
  last: number;
  /** Bumped when a release commits nothing, so the handles return to the committed span. */
  seat: number;
  onCommit: (first: number, last: number) => void;
}

/**
 * The two-handle brush over the desktop weeks. Its scale is linear in week units, so
 * the bounds visx reports are week indices. A held brush moves only its own handles:
 * nothing reads the drag until the release commits it. The brush is keyed by the
 * committed span, so a committed change (a chip, or the release of a drag) re-seats it.
 */
function WeekBrush({ count, totals, first, last, seat, onCommit }: WeekBrushProps) {
  const width = Math.max(count, 1) * WEEK_UNITS;
  const peak = Math.max(1, ...totals);
  const xScale = useMemo(() => scaleLinear<number>({ domain: [0, Math.max(count, 1)], range: [0, width] }), [count, width]);
  const yScale = useMemo(() => scaleLinear<number>({ domain: [0, 1], range: [BRUSH_HEIGHT, 0] }), []);
  const initialBrushPosition = useMemo(
    () => ({
      start: { x: first * WEEK_UNITS },
      end: { x: (last + 1) * WEEK_UNITS },
    }),
    [first, last],
  );
  return (
    <div aria-hidden="true" className="hidden grid-cols-[7.5rem_minmax(0,1fr)] gap-x-2 sm:grid">
      <span className="self-center text-[11px] leading-tight text-muted-foreground">Adjust the period</span>
      <svg
        aria-hidden="true"
        focusable="false"
        viewBox={`0 0 ${width} ${BRUSH_HEIGHT}`}
        preserveAspectRatio="none"
        className="block w-full select-none"
        style={{ height: BRUSH_HEIGHT }}
      >
        {totals.map((notices, index) =>
          notices > 0 ? (
            <rect
              key={index}
              x={index * WEEK_UNITS + 1}
              width={WEEK_UNITS - 2}
              y={BRUSH_HEIGHT - Math.max(2, (notices / peak) * (BRUSH_HEIGHT - 2))}
              height={Math.max(2, (notices / peak) * (BRUSH_HEIGHT - 2))}
              className="fill-muted-foreground/40"
            />
          ) : null,
        )}
        <Brush
          key={`${first}-${last}-${seat}`}
          xScale={xScale}
          yScale={yScale}
          width={width}
          height={BRUSH_HEIGHT}
          margin={{ top: 0, left: 0, right: 0, bottom: 0 }}
          handleSize={6}
          brushDirection="horizontal"
          resizeTriggerAreas={["left", "right"]}
          initialBrushPosition={initialBrushPosition}
          selectedBoxStyle={{
            fill: "hsl(var(--primary))",
            fillOpacity: 0.16,
            stroke: "hsl(var(--primary))",
            strokeWidth: 1,
          }}
          useWindowMoveEvents
          onBrushEnd={(bounds) => {
            if (bounds === null) return;
            const span = weeksUnderBrush(bounds, count);
            onCommit(span.first, span.last);
          }}
        />
      </svg>
    </div>
  );
}

/** The island's live half: reads the link, draws the window and commits the brush. */
function LiveMovementHeatmap({ initial, basePath, loadActivity, variant }: MovementHeatmapProps) {
  const workspace = variant === "full";
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const committed = useMemo(() => readNoticeWindow(params), [params]);
  // The page the grid draws: the server's default view until a link moves the window,
  // then the loader's page for it. A failed read keeps the page on screen.
  const [page, setPage] = useState(initial);
  const [seat, setSeat] = useState(0);
  // The workspace's controls: the measure of each cell and the holder kind the grid counts (the API's own filter).
  // The measure is a link parameter too (`measure=pp`), so the inspector's switch and a reload keep it.
  // Derived from the link, so a switch written in place (the inspector's, the control's) draws at once.
  const measure: HeatMeasure = workspace ? (params.get("measure") === "pp" ? "pp" : "count") : "pp";
  // The holder type starts as the selected cell's (spec 14.7), so a link to a cell shows the kind it counts.
  const selectedKind = useMemo(() => {
    const selection = parseSelection(params.get("sel") ?? "");
    return selection?.kind === "cell" ? (selection.holderKind ?? "") : "";
  }, [params]);
  const [kind, setKind] = useState(() => (workspace ? selectedKind : ""));
  const kindRef = useRef(kind);
  // The window the loader is asked for. A selection (`sel`) or any other link write leaves it
  // unchanged, so only a window move asks again.
  const windowKey = windowParamsKey(params);
  const askedWindow = useRef(windowKey);
  // ONE sequence for every ask: an answer applies only if no later ask has started, so an
  // older "All holders" answer can never overwrite the kind the select names.
  const sequence = useRef(0);
  const ask = (nextKind: string) => {
    if (loadActivity === undefined) return;
    const id = ++sequence.current;
    void loadActivity(nextKind === "" ? {} : { kind: nextKind }).then((answer) => {
      if (id === sequence.current && answer.ok) setPage(answer);
    });
  };
  useEffect(() => {
    if (askedWindow.current === windowKey) return;
    askedWindow.current = windowKey;
    ask(kindRef.current);
    // ask reads the loader and the sequence only; the window is the trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowKey, loadActivity]);
  // A link that names a holder type (a cell's `sel` carries one) asks for that kind once on mount,
  // so the grid draws the kind the inspector and the outline describe, not the all-holders page.
  useEffect(() => {
    if (workspace && selectedKind !== "") ask(selectedKind);
    // Mount only: a later selection moves the kind through the select, never through the link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chooseKind = (next: string) => {
    setKind(next);
    kindRef.current = next;
    ask(next);
  };
  const onMeasureChange = (value: string) => {
    const next: HeatMeasure = value === "count" ? "count" : "pp";
    // The measure is written in place, as the selection is, so the inspector's switch can name it.
    const writer = new URLSearchParams(window.location.search);
    if (next === "pp") writer.set("measure", "pp");
    else writer.delete("measure");
    const url = new URL(window.location.href);
    url.search = writer.toString();
    window.history.replaceState(null, "", url);
  };
  const onCellSelect = (sector: string, weekStart: string) => {
    // The cell is the grid's holder type as the grid counts it (spec 14.7): "" is every kind.
    const holderKind = kindRef.current === "" ? undefined : kindRef.current;
    const writer = new URLSearchParams(window.location.search);
    writer.set("sel", serializeSelection({ kind: "cell", sector, date: weekStart, holderKind }));
    const url = new URL(window.location.href);
    url.search = writer.toString();
    window.history.replaceState(null, "", url);
  };
  const controls = workspace ? (
    <>
      <SourceControl />
      <ToolbarSelect label="Measure" value={measure} onChange={onMeasureChange}>
        <option value="count">Notice count</option>
        <option value="pp">Voting power change</option>
      </ToolbarSelect>
      <ToolbarSelect label="Holder type" value={kind} onChange={chooseKind}>
        <option value="">All holders</option>
        {KIND_ORDER.map((option) => (
          <option key={option} value={option}>
            {kindSelectLabel(option)}
          </option>
        ))}
      </ToolbarSelect>
    </>
  ) : undefined;
  const weeks = useMemo(() => weekList(page.fromWeek, page.toWeek), [page.fromWeek, page.toWeek]);
  const span = useMemo(() => selectedWeekRange(committed, page.asOf, weeks), [committed, page.asOf, weeks]);
  const totals = useMemo(() => weekTotals(page.rows, weeks), [page.rows, weeks]);

  const onCommit = (first: number, last: number) => {
    const next = brushCommit(first, last, committed, weeks, page.asOf, committed.window);
    if (next === null) {
      // Nothing to commit: the handles go back to the span the link names.
      setSeat((value) => value + 1);
      return;
    }
    // The URL moves in place, as the map and the fund window do: a replaceState with
    // no state reaches useSearchParams, so a release costs no RSC request.
    window.history.replaceState(null, "", noticeWindowHref(basePath, params, next));
  };

  return (
    <MovementHeatmapView
      page={page}
      state={committed}
      basePath={basePath}
      params={params}
      controls={controls}
      toolbarFold={toolbarFold}
      onWindowChange={writeWindowInPlace}
      measure={measure}
      workspace={workspace}
      compact={variant === "compact"}
      kind={workspace ? kind : ""}
      onCellSelect={onCellSelect}
      brush={
        variant !== "compact" && span !== null ? (
          <WeekBrush
            count={weeks.length}
            totals={totals}
            first={span.first}
            last={span.last}
            seat={seat}
            onCommit={onCommit}
          />
        ) : null
      }
    />
  );
}

/**
 * The movement heatmap. The default view is the Suspense fallback, so the HTML
 * carries it and the island takes over once the link is read.
 */
export function MovementHeatmap(props: MovementHeatmapProps) {
  return (
    <Suspense
      fallback={
        <MovementHeatmapView
          page={props.initial}
          state={DESK_DEFAULT_WINDOW_STATE}
          basePath={props.basePath}
          params={new URLSearchParams()}
          measure={props.variant === "full" ? "count" : "pp"}
          workspace={props.variant === "full"}
          compact={props.variant === "compact"}
          controls={
            // The real row is one control high from sm (spec 14.9); the placeholder reserves that height.
            props.variant === "full" ? <div aria-hidden="true" className={TOOLBAR_ROW_CLASS} /> : undefined
          }
          brush={props.variant === "compact" ? null : <div aria-hidden="true" className="hidden sm:block" style={{ height: BRUSH_HEIGHT }} />}
        />
      }
    >
      <LiveMovementHeatmap {...props} />
    </Suspense>
  );
}
