"use client";

/**
 * The desk's map on /ownership (spec 13.2): the treemap of stocks by industry,
 * with its lenses, its window of change, a zoom to a sector and the stock panel.
 *
 * The island, the action as a prop and the link work as they do in
 * registers-explorer.tsx: the page is ISR and reads no `searchParams`, the server
 * renders the default view (OwnershipMapStatic, the Suspense fallback), and this
 * island reads the link after the first paint. Only the window of change asks the
 * server, a brushed pair of dates included; a lens and a zoom are drawn from the
 * figures already on the screen.
 *
 * The first render matches the server's fallback in its markup: the handlers that
 * make a cell a button arrive after mount, so hydration never meets a difference
 * it did not draw. The sr-only table lists every cell, so the drawing is never the
 * only record.
 *
 * EDITORIAL. Every sum is what the notices disclose, not a share of the company. A
 * stock with no figure for the lens is hatched, never painted as zero.
 */

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import type { DeskRangeInput, loadOwnershipMap, OwnershipMapPage } from "~/app/actions/ownershipDesk";
import { layoutMap, sectorOf, type MapStockRow } from "./map-layout";
import { SearchCombobox, type SearchComboboxOption } from "~/@/components/gamma/SearchCombobox";
import {
  DEFAULT_DESK_SORT,
  readDeskSort,
  readDeskState,
  writeDeskState,
  type DeskSort,
  type DeskState,
} from "./desk-state";
import { formatLensFigure, LENS_LABELS } from "./lens-legend";
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  OUTAGE_AFTER_MS,
  sizedRows,
  type MapSize,
  OwnershipMapStatic,
  OwnershipMapView,
  nextCellIndex,
  patchDeskParams,
  zoomPose,
  zoomStyle,
  type DeskPatch,
  type MapHandlers,
} from "./ownership-map-static";
import { StockPanel, type StockPanelPage } from "./stock-panel";
import { ViewDisclosure } from "../workspace/view-disclosure";
import { TOOLBAR_COMBOBOX_ROW_CLASS, ToolbarSelect, type ToolbarFold } from "~/@/components/workspace/toolbar";
import { writeWindowInPlace } from "../workspace/window-select";
import { writeSortInPlace } from "../workspace/sort-control";
import { SourceSelect } from "./source-control";
import {
  DESK_DEFAULT_WINDOW_STATE,
  readNoticeWindow,
  type NoticeWindow,
} from "./window-chips";

/** The island's phone fold of the workspace toolbar (spec 14.9): the client disclosure around the row. */
const mapToolbarFold: ToolbarFold = (row) => <ViewDisclosure>{row}</ViewDisclosure>;

export interface OwnershipMapProps {
  /** The default view the server rendered: the loader's answer to the default window. */
  initial: OwnershipMapPage;
  /** The map loader, passed down. It is typed as the action itself and never throws. */
  loadMap: typeof loadOwnershipMap;
  /** One stock's register for the panel, passed down. Resolves ok: false on an outage. */
  loadPanel: (code: string) => Promise<StockPanelPage>;
  /** The page's own path, which the chips link to. */
  basePath?: string;
  /**
   * `full` is the market map page; `compact` is the Overview's pane. Either one is
   * a workspace instrument: a click writes the selection (`?sel=stock:CODE`) for the
   * inspector to read, and draws no panel. Absent is the hub's panel, as before.
   */
  variant?: "compact" | "full";
  /**
   * The order the sectors are drawn in when the link names none (backlog C3). Absent is "largest"; the
   * hub's compact pane passes "changed". A link that names a valid sort always wins.
   */
  sort?: DeskSort;
}

/** The stock a `?sel=` names, or "" when it names none (the workspace's selection is read here). */
function stockOfSelection(raw: string): string {
  return raw.startsWith("stock:") && CODE_SHAPE.test(raw.slice("stock:".length)) ? raw.slice("stock:".length) : "";
}

type Status = "idle" | "loading" | "error";

interface MapState {
  /** The last good answer. Its figures belong to the window it was read for, which is `asked`. */
  page: OwnershipMapPage;
  /** What the controls hold: the desk's state as the link states it. */
  controls: DeskState;
  /** The window of change the link names, brushed pair included. */
  notice: NoticeWindow;
  status: Status;
  /** True once a request has been in flight for OUTAGE_AFTER_MS. */
  slow: boolean;
  /** The stock the panel shows, by code; "" is none. */
  selected: string;
  /** The cell the roving focus is on; "" is the first. */
  focusCode: string;
  /** The cell under the pointer or the focus, for the tooltip. */
  hovered: string | null;
  /** The start of a zoom, cleared one frame later so the transition runs. */
  pose: string | null;
}

/** The key a state is compared by: the codec's own link, so two states that write the same link are equal. */
function keyOf(desk: DeskState): string {
  return writeDeskState(desk);
}

/**
 * The key a window of change is asked by, the same one the flows island keys its
 * requests with: the days, then the brushed pair if there is one.
 */
function windowKey(window: NoticeWindow): string {
  return `${window.window}|${window.since}|${window.until}`;
}

const DEFAULT_WINDOW_KEY = windowKey(DESK_DEFAULT_WINDOW_STATE);
/** The server's default answer: the default window with no fund window (both are asked by runKey). */
const DEFAULT_RUN_KEY = runKey(DESK_DEFAULT_WINDOW_STATE, { from: "", to: "" });

/** The index fund window the link names (spec 14.10): both snapshot dates, or neither. */
interface FundDates {
  from: string;
  to: string;
}

/**
 * The key a request is asked under: the notice window and the fund window, so a link that moves
 * either one is asked again.
 */
function runKey(window: NoticeWindow, fund: FundDates): string {
  return `${windowKey(window)}|${fund.from}|${fund.to}`;
}

/**
 * The loader's input for a window: the brushed pair when there is one, else the days; and the fund
 * window when the link names one, so the map compares the same files the inspector reads.
 */
function loaderInput(window: NoticeWindow, fund: FundDates): DeskRangeInput {
  const notices = window.since !== "" ? { since: window.since, until: window.until } : { window: window.window };
  return fund.from !== "" && fund.to !== "" ? { ...notices, fundFrom: fund.from, fundTo: fund.to } : notices;
}

/**
 * Writes the reader's link with `params` as its query. Replace, never a new entry;
 * the caller builds the whole query, so the reader's other parameters are kept.
 */
function writeLink(params: URLSearchParams): void {
  const url = new URL(window.location.href);
  url.search = params.toString();
  // A null state, never the current one: Next stamps its own entries with a marker
  // that a replaceState carrying it would skip (see registers-explorer.tsx).
  window.history.replaceState(null, "", url);
}

/** Whether the reader asked for less motion. A browser without matchMedia has none to ask. */
function reducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

/**
 * The zoom's start pose for a change of sector, from the whole market's layout.
 * The sector's boxes do not depend on the lens, so either lens gives them.
 */
function zoomPoseFor(
  stocks: readonly MapStockRow[],
  prev: DeskState,
  next: DeskState,
  size?: MapSize,
  sort?: DeskSort,
): string | null {
  if (prev.sector === next.sector || reducedMotion()) return null;
  // The sector boxes move with the sort, so the zoom starts from the box the map draws (backlog C3).
  const whole = layoutMap(sizedRows(stocks, size), {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    lens: next.lens,
    sort,
    weights: stocks,
  });
  if (next.sector !== "" && prev.sector === "") {
    const box = whole.sectors.find((sector) => sector.sector === next.sector);
    return box ? zoomPose(box, "in") : null;
  }
  if (next.sector === "" && prev.sector !== "") {
    const box = whole.sectors.find((sector) => sector.sector === prev.sector);
    return box ? zoomPose(box, "out") : null;
  }
  return null;
}

/** The Size a control's value names; anything else is the market cap, the default area. */
export function mapSizeOf(value: string): MapSize {
  return value === "disclosed" || value === "index_fund" ? value : "market_cap";
}

/** A cell's code as an SVG attribute selector can take it: the API's own shape, no quotes or brackets. */
const CODE_SHAPE = /^[A-Z0-9]{1,6}$/;

function LiveMap({ initial, loadMap, loadPanel, basePath = "/ownership", variant, sort: defaultSort }: OwnershipMapProps) {
  const workspace = variant !== undefined;
  const compact = variant === "compact";
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const params = useMemo(() => new URLSearchParams(search), [search]);
  // The order the sectors are drawn in: the link's sort, else the instrument's own default (backlog C3).
  const sort = readDeskSort(params, defaultSort ?? DEFAULT_DESK_SORT);
  // In the workspace the selection is the link's: a clear, or a selection made by another
  // instrument on the page, moves the outline and the zoom with it.
  const linkedCode = workspace ? stockOfSelection(params.get("sel") ?? "") : "";
  const [state, setState] = useState<MapState>(() => {
    // The compact pane never zooms (spec 14.7): a sector in a link is not applied to it.
    const read = readDeskState(params);
    const controls = compact ? { ...read, sector: "" } : read;
    const notice = readNoticeWindow(params);
    return {
      page: initial,
      controls,
      notice,
      // The status the server drew, so the first render matches the fallback. A link that
      // names another window is drawn as loading, and the effect below asks for it.
      status: !initial.ok ? "error" : windowKey(notice) === DEFAULT_WINDOW_KEY ? "idle" : "loading",
      slow: false,
      selected: "",
      focusCode: "",
      hovered: null,
      pose: null,
    };
  });
  // Handlers arrive after mount, so the first render has the server's markup.
  const [mounted, setMounted] = useState(false);
  // The market cap is the default area (spec 13.2); the disclosed size is the workspace's Size control.
  const [size, setSize] = useState<MapSize>("market_cap");

  const sequence = useRef(0);
  const slowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // The window the screen holds an answer for. Null while there is none, so the effect asks again.
  const askedWindow = useRef<string | null>(initial.ok ? DEFAULT_RUN_KEY : null);
  const root = useRef<HTMLDivElement>(null);

  const run = useCallback(
    (window: NoticeWindow, fund: FundDates) => {
      const key = runKey(window, fund);
      const ticket = (sequence.current += 1);
      clearTimeout(slowTimer.current);
      slowTimer.current = setTimeout(() => {
        if (sequence.current === ticket) setState((s) => ({ ...s, slow: true }));
      }, OUTAGE_AFTER_MS);
      setState((s) => ({ ...s, status: "loading", slow: false }));
      const settle = (update: (s: MapState) => MapState) => {
        if (sequence.current !== ticket) return;
        clearTimeout(slowTimer.current);
        setState(update);
      };
      loadMap(loaderInput(window, fund)).then(
        (result) => {
          if (sequence.current === ticket) askedWindow.current = result.ok ? key : null;
          settle((s) =>
            result.ok
              ? { ...s, page: result, status: "idle", slow: false }
              : { ...s, status: "error", slow: false },
          );
        },
        () => {
          if (sequence.current === ticket) askedWindow.current = null;
          settle((s) => ({ ...s, status: "error", slow: false }));
        },
      );
    },
    [loadMap],
  );

  // Leaving the screen ends the wait: no outage timer outlives the island, and an answer
  // that arrives after it writes nothing. The asked window goes too, so the second mount
  // of a StrictMode pair asks again rather than trusting a request its first mount dropped.
  useEffect(() => {
    return () => {
      sequence.current += 1;
      clearTimeout(slowTimer.current);
      askedWindow.current = null;
    };
  }, []);

  useEffect(() => {
    setMounted(true);
  }, []);

  // The link's window of change, asked once per value the screen does not hold.
  useEffect(() => {
    const fund = { from: state.controls.from, to: state.controls.to };
    if (askedWindow.current === runKey(state.notice, fund)) return;
    askedWindow.current = runKey(state.notice, fund);
    run(state.notice, fund);
  }, [state.notice, state.controls.from, state.controls.to, run]);

  // A move of the link (back, forward, a hand-edited address) takes the link's state.
  useEffect(() => {
    const read = readDeskState(params);
    const controls = compact ? { ...read, sector: "" } : read;
    const notice = readNoticeWindow(params);
    setState((s) =>
      keyOf(s.controls) === keyOf(controls) && windowKey(s.notice) === windowKey(notice)
        ? s
        : { ...s, controls, notice },
    );
  }, [params, compact]);

  // One frame at the start pose, then the transition to none. Cancelled if the pose moves on.
  useEffect(() => {
    if (state.pose === null) return;
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) setState((s) => ({ ...s, pose: null }));
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
    };
  }, [state.pose]);

  // The map's own parameters are written into the reader's link; the window, its dates
  // and the index window's dates are left as the reader has them.
  const commit = (patch: DeskPatch) => {
    const next = patchDeskParams(new URLSearchParams(window.location.search), patch);
    setState((s) => {
      const controls = { ...s.controls, ...patch };
      return { ...s, controls, pose: zoomPoseFor(s.page.stocks, s.controls, controls, size, sort) };
    });
    writeLink(next);
  };

  const focusCell = (code: string) => {
    if (!CODE_SHAPE.test(code)) return;
    root.current?.querySelector<SVGGElement>(`g[data-code="${code}"]`)?.focus();
  };

  const selectedCode = workspace ? linkedCode : state.selected;

  const select = (code: string) => {
    if (!workspace) {
      setState((s) => ({ ...s, selected: code, focusCode: code }));
      return;
    }
    // The workspace selection: the inspector and the outline read it from the link, so the click writes it there.
    setState((s) => ({ ...s, focusCode: code }));
    const next = new URLSearchParams(window.location.search);
    next.set("sel", `stock:${code}`);
    writeLink(next);
  };

  const closePanel = () => {
    const code = selectedCode;
    if (!workspace) {
      setState((s) => ({ ...s, selected: "" }));
    } else {
      const next = new URLSearchParams(window.location.search);
      if (stockOfSelection(next.get("sel") ?? "") !== "") next.delete("sel");
      writeLink(next);
    }
    focusCell(code);
  };

  // A held answer is drawn for the window it was read for, so the figures the keys move
  // over are the ones on the screen, the hatched flow included.
  const layout = layoutMap(sizedRows(state.page.ok ? state.page.stocks : [], size), {
    width: MAP_WIDTH,
    height: MAP_HEIGHT,
    lens: state.controls.lens,
    sector: state.controls.sector,
    sort,
    weights: state.page.ok ? state.page.stocks : [],
  });

  // The workspace's Find: every stock by its code, and every sector the map names (spec 14.3).
  const findOptions = useMemo<SearchComboboxOption[]>(() => {
    const sectors = [...new Set(state.page.ok ? state.page.stocks.map((stock) => sectorOf(stock.industry)) : [])].sort();
    return [
      ...(state.page.ok ? state.page.stocks : []).map((stock) => ({
        value: `stock:${stock.code}`,
        label: `${stock.code}, ${stock.name}`,
        keywords: [stock.name],
      })),
      ...sectors.map((sector) => ({ value: `sector:${sector}`, label: sector, description: "Sector" })),
    ];
  }, [state.page]);

  const handlers: MapHandlers | undefined = mounted
    ? {
        onCellClick: select,
        onCellKey: (code, key) => {
          if (key === "Enter" || key === " ") {
            select(code);
            return;
          }
          if (key === "z") {
            // The cell's sector, from the whole market: a zoom out of a zoom is the crumb's and Escape's.
            // The compact pane does not zoom (spec 14.7): its sector bands open the full map instead.
            const cell = layout.cells.find((c) => c.code === code);
            if (!compact && cell && state.controls.sector === "") commit({ sector: cell.sector });
            return;
          }
          const index = layout.cells.findIndex((cell) => cell.code === code);
          const next = nextCellIndex(layout.cells, index, key);
          const target = layout.cells[next];
          if (target && next !== index) {
            setState((s) => ({ ...s, focusCode: target.code }));
            focusCell(target.code);
          }
        },
        onCellHover: (code) => setState((s) => (s.hovered === code ? s : { ...s, hovered: code })),
        onSectorZoom: (sector) => {
          if (compact) {
            router.push(`/ownership/map?${new URLSearchParams({ sector }).toString()}`);
            return;
          }
          commit({ sector });
        },
      }
    : undefined;

  const onRootKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Escape") return;
    // Escape inside the panel closes the panel the reader is in, not the zoom behind it.
    const inPanel = event.target instanceof Element && event.target.closest("aside") !== null;
    if (inPanel && selectedCode !== "") {
      event.preventDefault();
      closePanel();
    } else if (state.controls.sector !== "") {
      event.preventDefault();
      commit({ sector: "" });
    } else if (selectedCode !== "") {
      event.preventDefault();
      closePanel();
    }
  };

  const onPick = (patch: DeskPatch) => commit(patch);

  const hovered = state.hovered === null ? undefined : layout.cells.find((cell) => cell.code === state.hovered);
  const overlay = hovered ? (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute z-10 max-w-[14rem] -translate-x-1/2 -translate-y-full rounded-sm border bg-card px-2 py-1.5 text-[11px]"
      style={{
        left: `${(((hovered.x0 + hovered.x1) / 2) / MAP_WIDTH) * 100}%`,
        top: `${(hovered.y0 / MAP_HEIGHT) * 100}%`,
      }}
    >
      <span className="block font-mono font-medium">{hovered.code}</span>
      <span className="block text-muted-foreground">{hovered.name}</span>
      <span className="block text-muted-foreground">{hovered.sector}</span>
      <span className="block tabular-nums">
        {LENS_LABELS[state.controls.lens]}: {formatLensFigure(state.controls.lens, hovered.value)}
      </span>
    </div>
  ) : undefined;

  const scaleMax = state.page.stocks.reduce((max, stock) => Math.max(max, stock.disclosedPct), 0);
  const panel =
    !workspace && selectedCode !== "" ? (
      <StockPanel
        key={selectedCode}
        code={selectedCode}
        loadPanel={loadPanel}
        scaleMax={scaleMax > 0 ? scaleMax : 1}
        onClose={closePanel}
      />
    ) : undefined;

  // The workspace's controls: the source (the notices or the index fund files, which are two
  // lenses of the same map) and the size of each cell.
  const controlsNode = workspace ? (
    <>
      {/* The Find floor is 8rem: the map's row at 1440 (Find, Source, Size, Colour, Window, Sort) fits on one line
          only with it, and a wider floor wraps the Sort select onto a second line (spec 14.9). */}
      <div className="min-w-[8rem] flex-1 sm:max-w-[16rem]">
        <SearchCombobox
          label="Find company or sector"
          placeholder="Find company or sector"
          options={findOptions}
          clearable
          onValueChange={(value) => {
            if (value === null) return;
            if (value.startsWith("sector:")) commit({ sector: value.slice("sector:".length) });
            else if (value.startsWith("stock:")) select(value.slice("stock:".length));
          }}
        />
      </div>
      <SourceSelect
        value={state.controls.lens === "index" || state.controls.lens === "index_flow" ? "index" : "notices"}
        indexAvailable
        onChange={(value) => commit({ lens: value === "index" ? "index" : "disclosed" })}
      />
      <ToolbarSelect label="Size" value={size} onChange={(value) => setSize(mapSizeOf(value))}>
        <option value="market_cap">Market cap</option>
        <option value="disclosed">Exposure</option>
        <option value="index_fund">Fund holdings</option>
      </ToolbarSelect>
    </>
  ) : undefined;

  return (
    <OwnershipMapView
      toolbarFold={mapToolbarFold}
      variant={variant}
      size={size}
      controls={controlsNode}
      selectedCode={selectedCode}
      page={state.page}
      desk={state.controls}
      notice={state.notice}
      onWindowChange={writeWindowInPlace}
      sort={sort}
      onSortChange={writeSortInPlace}
      params={params}
      status={state.status}
      slow={state.slow}
      basePath={basePath}
      selected={selectedCode === "" ? undefined : selectedCode}
      focusCode={mounted && state.focusCode !== "" ? state.focusCode : undefined}
      handlers={handlers}
      groupStyle={zoomStyle(state.pose)}
      overlay={overlay}
      panel={panel}
      rootRef={root}
      onRootKeyDown={onRootKeyDown}
      onPick={onPick}
    />
  );
}

/**
 * The map. The default view is the Suspense fallback, drawn from the same props, so
 * the server HTML is the default view and the island takes over once it has read the link.
 */
export function OwnershipMap(props: OwnershipMapProps) {
  return (
    <Suspense
      fallback={
        <OwnershipMapStatic
          initial={props.initial}
          basePath={props.basePath}
          variant={props.variant}
          sort={props.sort ?? DEFAULT_DESK_SORT}
          // The full page's controls row is reserved, so the island mounting does not shift the drawing.
          controls={props.variant === "full" ? <div aria-hidden="true" className={TOOLBAR_COMBOBOX_ROW_CLASS} /> : undefined}
        />
      }
    >
      <LiveMap {...props} />
    </Suspense>
  );
}
