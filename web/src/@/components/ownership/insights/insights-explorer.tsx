"use client";

/**
 * The insights explorer on /ownership/insights: the market map, the position
 * heatmap and the money flow, all driven by one time window and one measure.
 *
 * The page is ISR and reads no `searchParams`. The server renders the default
 * view (this component's Suspense fallback, drawn from the same props), and the
 * island reads the link after the first paint, as the notice feed's island does.
 * Every re-query goes through the server action handed in as a prop, never a
 * browser Connect client; the island imports only the action's type. The link
 * is written with history.replaceState, defaults omitted.
 *
 * Three channels, each with its own ticket so a late answer never overwrites a
 * newer one: the window (the whole view), the focused sector (its full stock
 * list, institutions and moves) and the focused stock (its panel). A heatmap
 * cell is a fourth: the sector part for one bucket.
 *
 * EDITORIAL. A figure the window cannot state is n/a, never 0. A fall in a
 * notice's figure is a fall, never a disposal. Every disclosed sum says it is
 * what the notices disclose, not a share of the company.
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { loadOwnershipInsights } from "~/app/actions/ownershipInsights";
import { DISCLOSED_CAPTION, addDays, daysBetween, sectorLabel, windowText } from "~/@/lib/ownership/insights/format";
import {
  INSIGHT_PARAMS,
  parseInsightParams,
  serialiseInsightParams,
  type InsightsLink,
} from "~/@/lib/ownership/insights/query";
import type { InsightMeasure, InsightsPage, InsightsQuery } from "~/@/lib/ownership/insights/types";
import { sectionTitle } from "~/@/lib/typography";
import { cn } from "~/@/lib/utils";

import { DrillPanel, InstitutionList, PanelStatus, StockPanel } from "./insight-panels";
import { MarketMapLazy, MoneyFlowLazy, PositionHeatmapLazy } from "./insights-charts-lazy";
import { ChartTable, FlowTable, HeatmapTable, MovesList, SectorTable, StockRows } from "./insights-parts";
import type { HeatCellRef } from "./position-heatmap";
import { TimeWindow, stepWindow } from "./time-window";

type LoadInsights = typeof loadOwnershipInsights;
type Status = "idle" | "loading" | "error";

export interface InsightsExplorerProps {
  /** The default view the server rendered. */
  initial: InsightsPage;
  loadInsights: LoadInsights;
}

/** How long a window stays on screen while playing, after its answer arrives. */
export const PLAY_STEP_MS = 1600;

const SECTION_HEADING = `${sectionTitle} scroll-mt-20`;

interface Channel {
  page: InsightsPage | null;
  status: Status;
}

const IDLE: Channel = { page: null, status: "idle" };

interface ViewProps {
  page: InsightsPage;
  status: Status;
  measure: InsightMeasure;
  focus: string | null;
  stock: string;
  sector: Channel;
  stockChannel: Channel;
  cell: HeatCellRef | null;
  cellChannel: Channel;
  playing: boolean;
  interactive: boolean;
  onWindow: (from: string, to: string) => void;
  onMeasure: (measure: InsightMeasure) => void;
  onFocus: (sector: string | null) => void;
  onStock: (code: string) => void;
  onCell: (cell: HeatCellRef | null) => void;
  onPlay: () => void;
}

const MEASURES: ReadonlyArray<{ value: InsightMeasure; label: string; hint: string }> = [
  { value: "funds", label: "Index funds", hint: "AUD held, change in shares" },
  { value: "disclosed", label: "Disclosed stakes", hint: "voting power, notice moves" },
];

function fundsCaption(page: InsightsPage): string {
  const w = page.window;
  const end = w.endFilesFrom ? `files ${windowText(w.endFilesFrom, w.endFilesTo)}` : "no file at the window's end";
  if (w.fundsCompared === 0) {
    return `Area: what the index funds tracked hold, ${end}. No index fund has two files in this window, so every change is n/a: widen the window, or switch to disclosed stakes. Vanguard's files are the pooled fund behind each ETF.`;
  }
  return `Area: what the index funds tracked hold, ${end}. Colour: the change in shares held by the ${w.fundsCompared} funds with a file at both ends, from files ${windowText(w.startFilesFrom, w.startFilesTo)}, each fund compared with itself. Vanguard's files are the pooled fund behind each ETF.`;
}

function disclosedCaption(page: InsightsPage): string {
  const w = page.window;
  return `Area: disclosed voting power times market cap, each interest counted once, as the newest notices read state it (notices read to ${w.noticesAsOf || "n/a"}): ${DISCLOSED_CAPTION}. Colour: the net change in voting power the ${w.noticesInWindow.toLocaleString("en-AU")} notices dated ${windowText(w.from, w.to)} state.`;
}

/** The whole view. The island and the server's fallback draw this same markup. */
function InsightsView({
  page,
  status,
  measure,
  focus,
  stock,
  sector,
  stockChannel,
  cell,
  cellChannel,
  playing,
  interactive,
  onWindow,
  onMeasure,
  onFocus,
  onStock,
  onCell,
  onPlay,
}: ViewProps) {
  const w = page.window;
  const busy = status === "loading";
  const failed = status === "error" || (status === "idle" && !page.ok);
  // A focused sector shows its full stock list once its part arrives, and the capped list until then.
  const sectorStocks = focus !== null && sector.page?.ok ? sector.page.stocks : page.stocks;
  const mapStocks = focus !== null ? sectorStocks : page.stocks;
  const stockRow = useMemo(
    () => mapStocks.find((s) => s.code === stock) ?? page.stocks.find((s) => s.code === stock),
    [mapStocks, page.stocks, stock],
  );
  const flow = measure === "funds" ? page.flowFunds : page.flowDisclosed;
  const cellBucket = cell ? page.heatmap.buckets[cell.bucket] : undefined;

  return (
    <div className="space-y-12">
      <section aria-label="Time window and measure" className="space-y-4 rounded-lg border border-border bg-card p-4 sm:p-5">
        <TimeWindow
          timelineFrom={w.timelineFrom}
          timelineTo={w.timelineTo}
          from={w.from}
          to={w.to}
          snapshotDates={w.snapshotDates}
          timeline={page.timeline}
          bucket={w.bucket}
          playing={playing}
          disabled={!interactive || !page.ok}
          onChange={onWindow}
          onPlay={onPlay}
        />
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/60 pt-3">
          <div role="radiogroup" aria-label="Measure" className="inline-flex rounded-md border border-border p-0.5">
            {MEASURES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={measure === m.value}
                disabled={!interactive}
                onClick={() => onMeasure(m.value)}
                className={cn(
                  "hit-target inline-flex h-9 flex-col items-start justify-center rounded px-3 text-left text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  measure === m.value ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{m.label}</span>
                <span className="hidden text-[10px] font-normal text-muted-foreground sm:block">{m.hint}</span>
              </button>
            ))}
          </div>
          <p className="text-[11px] text-muted-foreground tabular-nums" role="status">
            {failed
              ? "The insights could not be read just now. Nothing is missing from the register: this is our end."
              : busy
                ? "Loading the window…"
                : `${w.fundsCompared.toLocaleString("en-AU")} of ${w.fundsAtEnd.toLocaleString("en-AU")} funds compared, ${w.noticesInWindow.toLocaleString("en-AU")} notices in the window`}
          </p>
        </div>
      </section>

      <div className={cn("space-y-12 transition-opacity duration-200 motion-reduce:transition-none", busy && "opacity-60")} aria-busy={busy}>
        <section aria-labelledby="map" className="space-y-3">
          <h2 id="map" className={SECTION_HEADING}>
            Market map
          </h2>
          <p className="max-w-[80ch] text-xs text-muted-foreground">
            {measure === "funds" ? fundsCaption(page) : disclosedCaption(page)} Press a sector to zoom in, a stock for
            its holders.
          </p>
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <MarketMapLazy
              sectors={page.sectors}
              stocks={mapStocks}
              remainders={focus !== null && sector.page?.ok ? [] : page.remainders}
              measure={measure}
              focus={focus}
              selected={stock}
              onFocusSector={onFocus}
              onSelectStock={onStock}
            />
            <aside aria-label="Selection" className="min-w-0 rounded-lg border border-border bg-card p-4">
              {stock ? (
                <StockPanel
                  code={stock}
                  stock={stockRow}
                  detail={stockChannel.page?.stockDetail ?? null}
                  status={stockChannel.status}
                  from={w.from}
                  to={w.to}
                  onClose={() => onStock("")}
                />
              ) : focus !== null ? (
                <div className="space-y-4">
                  <h3 className="text-base font-semibold">{sectorLabel(focus)}</h3>
                  {sector.status !== "idle" ? <PanelStatus status={sector.status === "loading" ? "loading" : "error"} /> : null}
                  {sector.page?.ok ? (
                    <div className="space-y-2">
                        <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                          {measure === "funds" ? "Institutions, by change" : "Largest stated moves"}
                        </p>
                        {measure === "funds" ? (
                          <InstitutionList institutions={sector.page.sectorInstitutions} />
                        ) : (
                          <MovesList moves={sector.page.moves.slice(0, 8)} empty="No notice in this sector states both figures in the window." />
                        )}
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="space-y-2">
                  <h3 className="text-base font-semibold">Largest stated moves</h3>
                  <p className="text-[11px] text-muted-foreground">
                    Notices dated {windowText(w.from, w.to)} that state both figures, by the size of the move.
                  </p>
                  <MovesList moves={page.moves.slice(0, 10)} empty="No notice in this window states both figures." />
                </div>
              )}
            </aside>
          </div>
          <ChartTable title={focus === null ? "The market map as a table: every sector" : `The market map as a table: ${sectorLabel(focus)}`}>
            {focus === null ? (
              <SectorTable sectors={page.sectors} caption={`Window ${windowText(w.from, w.to)}. Disclosed stakes are ${DISCLOSED_CAPTION}.`} />
            ) : (
              <StockRows stocks={sectorStocks.filter((s) => s.sector === focus)} measure={measure} limit={60} />
            )}
          </ChartTable>
        </section>

        <section aria-labelledby="heatmap" className="space-y-3">
          <h2 id="heatmap" className={SECTION_HEADING}>
            Position changes
          </h2>
          <p className="max-w-[80ch] text-xs text-muted-foreground">
            {measure === "funds"
              ? `Each ${w.bucket || "bucket"}, the change in shares the index funds hold by sector, valued at the later file's price: each fund compared with its own earlier file.`
              : `Each ${w.bucket || "bucket"}, the net change in voting power the notices dated in it state, by sector: present less previous, where a notice states both. A fall is a fall, not a disposal.`}{" "}
            Window {windowText(w.from, w.to)}. Press a cell for the stocks and holders behind it.
          </p>
          <PositionHeatmapLazy
            heatmap={page.heatmap}
            measure={measure}
            bucket={w.bucket}
            focusSector={focus}
            selected={cell}
            onSelect={(next) => onCell(cell && cell.bucket === next.bucket && cell.sector === next.sector ? null : next)}
          />
          {cell && cellBucket ? (
            <DrillPanel
              title={
                <>
                  {sectorLabel(cell.sector)}, <time dateTime={cellBucket.start}>{cellBucket.start}</time> to{" "}
                  <time dateTime={cellBucket.end}>{cellBucket.end}</time>
                </>
              }
              measure={measure}
              stocks={(cellChannel.page?.stocks ?? []).filter((s) => s.sector === cell.sector)}
              institutions={cellChannel.page?.sectorInstitutions ?? []}
              moves={cellChannel.page?.moves ?? []}
              status={cellChannel.status === "idle" && !cellChannel.page ? "loading" : cellChannel.status}
              onClose={() => onCell(null)}
            />
          ) : null}
          <ChartTable title="Position changes as a table">
            <HeatmapTable heatmap={page.heatmap} measure={measure} bucket={w.bucket} />
          </ChartTable>
        </section>

        <section aria-labelledby="flow" className="space-y-3">
          <h2 id="flow" className={SECTION_HEADING}>
            Money flow
          </h2>
          <p className="max-w-[80ch] text-xs text-muted-foreground">
            {measure === "funds"
              ? `What the index fund and super option files hold at the window's end (files ${windowText(flow.asAtFrom, flow.asAtTo)}), from institution kind through the ten largest institutions to sector. A super option is one investment option, not the whole fund.`
              : `Disclosed voting power times market cap, as the newest notices read state it (to ${flow.asAtTo || "n/a"}), from holder kind through the ten largest holders to sector: ${DISCLOSED_CAPTION}.`}
          </p>
          <MoneyFlowLazy flow={flow} focusSector={focus} onFocusSector={onFocus} />
          <ChartTable title="The money flow as a table">
            <FlowTable flow={flow} caption={measure === "funds" ? "Fund files at the window's end, AUD." : `Disclosed stakes, AUD: ${DISCLOSED_CAPTION}.`} />
          </ChartTable>
        </section>
      </div>
    </div>
  );
}

/** Writes the link, and returns its query string as useSearchParams will read it. */
function writeLink(link: InsightsLink, defaultWindow: { from: string; to: string }): string {
  const url = new URL(window.location.href);
  for (const name of INSIGHT_PARAMS) url.searchParams.delete(name);
  serialiseInsightParams(link, defaultWindow).forEach((value, name) => url.searchParams.set(name, value));
  // A null state, never the current one: Next's own entries carry a marker that
  // would stop useSearchParams following the link (registers-explorer.tsx).
  window.history.replaceState(null, "", url);
  return url.searchParams.toString();
}

function LiveInsights({ initial, loadInsights }: InsightsExplorerProps) {
  const searchParams = useSearchParams();
  const search = searchParams?.toString() ?? "";
  const first = useMemo(() => parseInsightParams(new URLSearchParams(search)), []); // eslint-disable-line react-hooks/exhaustive-deps
  const defaultWindow = useMemo(() => ({ from: initial.window.from, to: initial.window.to }), [initial]);

  const [page, setPage] = useState<InsightsPage>(initial);
  const [status, setStatus] = useState<Status>(initial.ok ? "idle" : "loading");
  const [measure, setMeasure] = useState<InsightMeasure>(first.measure);
  const [focus, setFocus] = useState<string | null>(first.query.sector);
  const [stock, setStock] = useState(first.query.stock);
  const [sector, setSector] = useState<Channel>(IDLE);
  const [stockChannel, setStockChannel] = useState<Channel>(IDLE);
  const [cell, setCell] = useState<HeatCellRef | null>(null);
  const [cellChannel, setCellChannel] = useState<Channel>(IDLE);
  const [playing, setPlaying] = useState(false);

  const tickets = useRef({ all: 0, sector: 0, stock: 0, cell: 0 });
  // False until the screen holds what the arriving link asked for: the link is
  // never rewritten to a window the reader did not ask for while theirs loads.
  const synced = useRef(false);
  const windowRef = useRef({ from: initial.window.from, to: initial.window.to });

  // Leaving the screen ends every wait: an answer that settles later writes nothing.
  useEffect(() => {
    const t = tickets.current;
    return () => {
      t.all += 1;
      t.sector += 1;
      t.stock += 1;
      t.cell += 1;
    };
  }, []);

  const ask = useCallback(
    (channel: "sector" | "stock" | "cell", query: InsightsQuery, set: (c: Channel) => void) => {
      const ticket = (tickets.current[channel] += 1);
      set({ page: null, status: "loading" });
      const part = channel === "stock" ? "stock" : "sector";
      loadInsights({ from: query.from, to: query.to, sector: query.sector, stock: query.stock, part }).then(
        (answer) => {
          if (tickets.current[channel] !== ticket) return;
          set({ page: answer, status: answer.ok ? "idle" : "error" });
        },
        () => {
          if (tickets.current[channel] === ticket) set({ page: null, status: "error" });
        },
      );
    },
    [loadInsights],
  );

  const loadSector = useCallback(
    (name: string | null, win = windowRef.current) => {
      if (name === null) {
        tickets.current.sector += 1;
        setSector(IDLE);
        return;
      }
      ask("sector", { from: win.from, to: win.to, sector: name, stock: "" }, setSector);
    },
    [ask],
  );

  const loadStock = useCallback(
    (code: string, win = windowRef.current) => {
      if (!code) {
        tickets.current.stock += 1;
        setStockChannel(IDLE);
        return;
      }
      ask("stock", { from: win.from, to: win.to, sector: null, stock: code }, setStockChannel);
    },
    [ask],
  );

  const focusRef = useRef(focus);
  const stockRef = useRef(stock);
  focusRef.current = focus;
  stockRef.current = stock;

  const loadWindow = useCallback(
    (from: string, to: string) => {
      const ticket = (tickets.current.all += 1);
      setStatus("loading");
      setCell(null);
      tickets.current.cell += 1;
      setCellChannel(IDLE);
      loadInsights({ from, to, part: "all" }).then(
        (answer) => {
          if (tickets.current.all !== ticket) return;
          if (!answer.ok) {
            setStatus("error");
            setPlaying(false);
            return;
          }
          setPage(answer);
          setStatus("idle");
          synced.current = true;
          const win = { from: answer.window.from, to: answer.window.to };
          windowRef.current = win;
          if (focusRef.current !== null) loadSector(focusRef.current, win);
          if (stockRef.current) loadStock(stockRef.current, win);
        },
        () => {
          if (tickets.current.all === ticket) {
            setStatus("error");
            setPlaying(false);
          }
        },
      );
    },
    [loadInsights, loadSector, loadStock],
  );

  // The first look at the link: the server's default view answers the default
  // link; anything else is asked for once.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const { query } = first;
    const wantsWindow =
      (query.from !== "" || query.to !== "") && (query.from !== initial.window.from || query.to !== initial.window.to);
    if (!initial.ok || wantsWindow) {
      loadWindow(query.from || "", query.to || "");
      return () => {
        started.current = false;
      };
    }
    synced.current = true;
    if (query.sector !== null) loadSector(query.sector);
    if (query.stock) loadStock(query.stock);
    // Under StrictMode the island mounts, unmounts and mounts again. The unmount
    // drops the answers in flight, so the second mount must ask again.
    return () => {
      started.current = false;
    };
  }, [first, initial, loadWindow, loadSector, loadStock]);

  // The link follows the screen. What it writes is remembered, so a link the
  // island did not write (a press on a link to this page) is read again below.
  const written = useRef(search);
  useEffect(() => {
    if (!started.current || !synced.current) return;
    written.current = writeLink(
      { query: { from: page.window.from, to: page.window.to, sector: focus, stock }, measure },
      defaultWindow,
    );
  }, [page.window.from, page.window.to, focus, stock, measure, defaultWindow]);

  useEffect(() => {
    if (!started.current || !synced.current || search === written.current) return;
    written.current = search;
    const next = parseInsightParams(new URLSearchParams(search));
    setMeasure(next.measure);
    if (next.query.sector !== focusRef.current) {
      setFocus(next.query.sector);
      loadSector(next.query.sector);
    }
    if (next.query.stock !== stockRef.current) {
      setStock(next.query.stock);
      loadStock(next.query.stock);
    }
    const wantsWindow =
      (next.query.from !== "" || next.query.to !== "") &&
      (next.query.from !== windowRef.current.from || next.query.to !== windowRef.current.to);
    if (wantsWindow) loadWindow(next.query.from, next.query.to);
  }, [search, loadSector, loadStock, loadWindow]);

  // Play: one step per answer, held on screen for PLAY_STEP_MS, until the window reaches the end.
  useEffect(() => {
    if (!playing || status !== "idle") return;
    const w = page.window;
    if (w.to >= w.timelineTo) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => {
      const next = stepWindow(w.from, w.to, 1, w.bucket, w.timelineFrom, w.timelineTo);
      loadWindow(next.from, next.to);
    }, PLAY_STEP_MS);
    return () => clearTimeout(timer);
  }, [playing, status, page.window, loadWindow]);

  const onWindow = useCallback(
    (from: string, to: string) => {
      if (from === page.window.from && to === page.window.to) return;
      loadWindow(from, to);
    },
    [page.window.from, page.window.to, loadWindow],
  );

  const onFocus = useCallback(
    (name: string | null) => {
      setFocus(name);
      loadSector(name);
    },
    [loadSector],
  );

  const onStock = useCallback(
    (code: string) => {
      const next = code === stock ? "" : code;
      setStock(next);
      loadStock(next);
    },
    [stock, loadStock],
  );

  const onCell = useCallback(
    (next: HeatCellRef | null) => {
      setCell(next);
      if (next === null) {
        tickets.current.cell += 1;
        setCellChannel(IDLE);
        return;
      }
      const b = page.heatmap.buckets[next.bucket];
      if (!b) return;
      ask("cell", { from: b.start, to: b.end, sector: next.sector, stock: "" }, setCellChannel);
    },
    [ask, page.heatmap.buckets],
  );

  // Play steps the window forward; from the end it starts again at the first
  // window of the same length.
  const onPlay = useCallback(() => {
    if (playing) {
      setPlaying(false);
      return;
    }
    const w = page.window;
    if (w.to >= w.timelineTo && w.timelineFrom) {
      const length = daysBetween(w.from, w.to);
      const end = addDays(w.timelineFrom, length);
      loadWindow(w.timelineFrom, end > w.timelineTo ? w.timelineTo : end);
    }
    setPlaying(true);
  }, [playing, page.window, loadWindow]);

  return (
    <InsightsView
      page={page}
      status={status}
      measure={measure}
      focus={focus}
      stock={stock}
      sector={sector}
      stockChannel={stockChannel}
      cell={cell}
      cellChannel={cellChannel}
      playing={playing}
      interactive
      onWindow={onWindow}
      onMeasure={setMeasure}
      onFocus={onFocus}
      onStock={onStock}
      onCell={onCell}
      onPlay={onPlay}
    />
  );
}

const NOOP = () => undefined;

/**
 * The explorer. The default view is the Suspense fallback, drawn from the same
 * props, so the server HTML is the default view (the charts' tables included)
 * and the island takes over once it has read the link.
 */
export function InsightsExplorer(props: InsightsExplorerProps) {
  return (
    <Suspense
      fallback={
        <InsightsView
          page={props.initial}
          status={props.initial.ok ? "idle" : "loading"}
          measure="funds"
          focus={null}
          stock=""
          sector={IDLE}
          stockChannel={IDLE}
          cell={null}
          cellChannel={IDLE}
          playing={false}
          interactive={false}
          onWindow={NOOP}
          onMeasure={NOOP}
          onFocus={NOOP}
          onStock={NOOP}
          onCell={NOOP}
          onPlay={NOOP}
        />
      }
    >
      <LiveInsights {...props} />
    </Suspense>
  );
}
