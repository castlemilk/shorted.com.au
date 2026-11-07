"use client";

/**
 * The flows island (spec 13.3): the positions and the window's changes, redrawn
 * when the window changes. The server draws the default view into the HTML
 * (ownership-flows-static.tsx); this island reads the link under its own Suspense
 * boundary and asks the loader for the window the link names.
 *
 * WHY THE LOADER ARRIVES AS A PROP. A "use client" module may not reach the
 * generated protobuf or an action (client-boundary.test.ts). The page passes
 * app/actions/ownershipDesk.ts's loadOwnershipFlows down, and this module imports
 * only its types.
 *
 * WHAT IT KEEPS. A window that is loading leaves the drawing it had on the screen,
 * with the busy line beside it, so a chip press never empties the instrument. A
 * request the reader has moved past is dropped: only the newest may write, so two
 * quick changes cannot leave the first window's rows on the screen. A failed read
 * (ok: false) is the outage line, never an empty flow.
 *
 * THE MODE IS LOCAL. Positions and changes are a switch on this instrument, not a
 * link parameter: the window is what the desk shares, the switch is one chart's.
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState } from "react";

import type { DeskRangeInput, OwnershipFlowsPage } from "~/app/actions/ownershipDesk";
import { SourceControl } from "./source-control";
import { ViewDisclosure } from "../workspace/view-disclosure";
import { TOOLBAR_ROW_CLASS, ToolbarSelect, type ToolbarFold } from "~/@/components/workspace/toolbar";
import { writeWindowInPlace } from "../workspace/window-select";
import {
  OwnershipFlowsView,
  drillPage,
  largestConnections,
  measurePage,
  type DrillPatch,
  type FlowMeasure,
  type FlowMode,
  type LargestChoice,
} from "./ownership-flows-static";
import { kindInfo } from "~/@/lib/ownership/kinds";
import {
  DESK_DEFAULT_WINDOW_STATE,
  readNoticeWindow,
  type NoticeWindow,
} from "./window-chips";

/** The island's phone fold of the toolbar (spec 14.9): the client disclosure around the row. */
const flowsToolbarFold: ToolbarFold = (row) => <ViewDisclosure>{row}</ViewDisclosure>;

export interface OwnershipFlowsProps {
  /** The default view the server rendered: the newest notice window, positions and changes. */
  initial: OwnershipFlowsPage;
  /** The loader for a window: days back from the newest notice, or a brushed pair of dates. */
  loadFlows: (input: DeskRangeInput) => Promise<OwnershipFlowsPage>;
  /** The path the window chips link to. */
  basePath: string;
  /**
   * `full` is the Connections page: Measure, Largest and Reset are
   * drawn above the drawings. `compact` is the Overview's pane, drawn as it is.
   */
  variant?: "compact" | "full";
}

/** The window as one string, the key a request and a shown view are compared by. */
function keyOf(state: NoticeWindow): string {
  return `${state.window}|${state.since}|${state.until}`;
}

const DEFAULT_KEY = keyOf(DESK_DEFAULT_WINDOW_STATE);

/** The loader's input for a window key: the brushed pair when there is one, else the days. */
function inputFromKey(key: string): DeskRangeInput {
  const [days, since, until] = key.split("|");
  return since ? { since, until } : { window: Number(days) };
}

const OUTAGE_PAGE: OwnershipFlowsPage = {
  ok: false,
  error: "",
  from: "",
  to: "",
  asOf: "",
  positions: [],
  changes: [],
};

interface Shown {
  state: NoticeWindow;
  page: OwnershipFlowsPage;
}

/** One crumb of the drilldown: its label, and the drill it returns to when pressed. */
export interface DrillCrumb {
  label: string;
  patch: DrillPatch;
}

/**
 * The breadcrumb of a drilldown (spec 14.3): "All holders / Index managers / Materials".
 * Empty when nothing is drilled, so the drawing's first render has no crumb row.
 */
export function drillCrumbs(drill: DrillPatch): DrillCrumb[] {
  const kind = drill.kind ?? "";
  const sector = drill.sector ?? "";
  if (kind === "" && sector === "") return [];
  const crumbs: DrillCrumb[] = [{ label: "All holders", patch: {} }];
  if (kind !== "") crumbs.push({ label: kindInfo(kind).plural, patch: { kind } });
  if (sector !== "") crumbs.push({ label: sector, patch: { kind, sector } });
  return crumbs;
}

function LiveOwnershipFlows({ initial, loadFlows, basePath, variant }: OwnershipFlowsProps) {
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const state = useMemo(() => readNoticeWindow(params), [params]);
  const key = keyOf(state);

  // The Positions | Change view is a link parameter (`view=changes`), so the inspector reads the window's notices for it.
  // The Overview's pane is positions only (backlog B2): its link's view is not read.
  const mode: FlowMode = variant !== "compact" && params.get("view") === "changes" ? "changes" : "positions";
  const [measure, setMeasure] = useState<FlowMeasure>("exposure");
  const [largest, setLargest] = useState<LargestChoice>("all");
  // The drilldown (spec 14.3, Connections): a holder kind, a sector, or both narrow the drawing to their bands.
  const [drill, setDrill] = useState<DrillPatch>({});
  // The folded tail of the sankey (spec 14.9): six sectors and "Other sectors" until Expand Other + opens it.
  const [tailOpen, setTailOpen] = useState(false);
  const [shown, setShown] = useState<Shown>({ state: DESK_DEFAULT_WINDOW_STATE, page: initial });
  const [busy, setBusy] = useState(false);
  // The key of the window on the screen, the key being loaded, and the sequence of the newest request.
  const shownKey = useRef(DEFAULT_KEY);
  const pendingKey = useRef<string | null>(null);
  const sequence = useRef(0);

  useEffect(() => {
    // A change that leaves the window as it is (a zoomed sector, a mode) asks nothing.
    if (key === pendingKey.current) return;
    // Back on the window on the screen: a request still in flight is stale, so it may not write.
    if (key === shownKey.current) {
      sequence.current += 1;
      pendingKey.current = null;
      setBusy(false);
      return;
    }
    const ticket = (sequence.current += 1);
    pendingKey.current = key;
    setBusy(true);
    const settle = (page: OwnershipFlowsPage) => {
      if (sequence.current !== ticket) return;
      shownKey.current = key;
      pendingKey.current = null;
      setShown({ state, page });
      setBusy(false);
    };
    loadFlows(inputFromKey(key)).then(settle, () => settle(OUTAGE_PAGE));
  }, [key, state, loadFlows]);

  const reset = () => {
    setMeasure("exposure");
    setLargest("all");
    setDrill({});
    setTailOpen(false);
  };
  // A band selects in place: the link's sel is written with replaceState, which useSearchParams
  // observes, so the inspector follows with no request (the map and the heatmap write the same way).
  const onModeChange = (next: FlowMode) => {
    const writer = new URLSearchParams(window.location.search);
    if (next === "changes") writer.set("view", "changes");
    else writer.delete("view");
    const url = new URL(window.location.href);
    url.search = writer.toString();
    window.history.replaceState(null, "", url);
  };
  const onSelect = (sel: string) => {
    const writer = new URLSearchParams(window.location.search);
    writer.set("sel", sel);
    const url = new URL(window.location.href);
    url.search = writer.toString();
    window.history.replaceState(null, "", url);
  };
  const crumbs = drillCrumbs(drill);
  // The Connections page's controls: the measure of each band, how many bands are drawn, and the reset.
  const controls =
    variant === "full" ? (
      <>
        <SourceControl />
        <ToolbarSelect label="Measure" value={measure} onChange={(value) => setMeasure(value === "count" ? "count" : "exposure")}>
          <option value="exposure">Exposure</option>
          <option value="count">Interests</option>
        </ToolbarSelect>
        <ToolbarSelect label="Largest" value={largest} onChange={(value) => setLargest(value as LargestChoice)}>
          <option value="10">10</option>
          <option value="20">20</option>
          <option value="all">All</option>
        </ToolbarSelect>
        <button type="button" onClick={reset} className="text-xs text-primary underline-offset-4 hover:underline">
          Reset
        </button>
      </>
    ) : undefined;
  return (
    <>
      {crumbs.length === 0 ? null : (
        <nav aria-label="Drilldown" className="mb-3 text-[11px] text-muted-foreground">
          <ol className="flex flex-wrap items-center gap-1">
            {crumbs.map((crumb, index) => {
              const last = index === crumbs.length - 1;
              return (
                <li key={crumb.label} className="flex items-center gap-1">
                  {index > 0 ? <span aria-hidden="true">{">"}</span> : null}
                  {last ? (
                    <span aria-current="location" className="text-foreground">
                      {crumb.label}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setDrill(crumb.patch)}
                      className="text-primary underline-offset-4 hover:underline"
                    >
                      {crumb.label}
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        </nav>
      )}
      <OwnershipFlowsView
      toolbarFold={flowsToolbarFold}
        onWindowChange={writeWindowInPlace}
        page={largestConnections(measurePage(drillPage(shown.page, drill), measure), largest)}
        mode={mode}
        state={shown.state}
        basePath={basePath}
        params={params}
        onModeChange={onModeChange}
        busy={busy}
        controls={controls}
        measure={measure}
        onSelect={onSelect}
        expandOther={tailOpen}
        onExpandOther={() => setTailOpen(true)}
        onFoldOther={() => setTailOpen(false)}
        tailToggle={variant === "full"}
        compact={variant === "compact"}
        // The drilldown is the Connections page's; the Overview's pane keeps its links to the directories.
        onDrill={variant === "full" ? (patch) => setDrill((current) => ({ ...current, ...patch })) : undefined}
      />
    </>
  );
}

/**
 * The flows instrument. The default view is the Suspense fallback, so the HTML
 * carries it and the island takes over once the link is read.
 */
export function OwnershipFlows(props: OwnershipFlowsProps) {
  return (
    <Suspense
      fallback={
        <OwnershipFlowsView
          page={props.initial}
          mode="positions"
          state={DESK_DEFAULT_WINDOW_STATE}
          basePath={props.basePath}
          params={new URLSearchParams()}
          compact={props.variant === "compact"}
          // The full page's controls row is reserved, so the island mounting does not shift the drawing.
          controls={props.variant === "full" ? <div aria-hidden="true" className={TOOLBAR_ROW_CLASS} /> : undefined}
        />
      }
    >
      <LiveOwnershipFlows {...props} />
    </Suspense>
  );
}
