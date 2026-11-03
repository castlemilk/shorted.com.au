"use client";

/**
 * The index fund window on /ownership (spec 13.5): the two snapshot dates, the
 * changes in weight between them, and one stock's weight in each tracked fund.
 *
 * WHY A CLIENT ISLAND ON AN ISR PAGE. The hub must not read `searchParams`, so
 * the server renders the default view (the two newest snapshot dates) and this
 * island reads `?from=&to=` itself, under its own Suspense boundary whose fallback
 * is that same view. The island reads the link once, when it mounts: the slider
 * writes the link itself, and a re-read would ask again for what it just asked.
 *
 * WHY THE LOADERS ARRIVE AS PROPS. A "use client" module may not reach the
 * generated protobuf module or an action at run time (client-boundary.test.ts),
 * so the page passes the two loaders down. They never throw: a read that did not
 * answer is `ok: false`, an outage, and a refused query is `ok: false` with its
 * reason in `error`.
 *
 * EDITORIAL. A weight is the fund's, not a share of the company. A stock held on
 * one date only is New or Dropped, never a change from zero. Nothing is red or
 * green. Every figure is the file's own, and the AUD change is marked estimated.
 *
 * A STALE ANSWER NEVER WINS. Each request carries a sequence number and only the
 * newest may write state, so a quick run of slider moves cannot leave the rows of
 * an earlier pair on the screen.
 *
 * A DRAG IS ONE REQUEST. The handles move at once, and the request goes out once
 * they have been still for a moment, so a drag over many snapshots is one read.
 */

import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import type { FundPositionChangesPage, StockFundSeriesPage } from "~/app/actions/ownershipDesk";
import { readDeskState, writeDeskState } from "./desk-state";
import { FUND_POSITIONS_OUTAGE, FundPositionsView, FundStockPanel } from "./fund-positions-static";

/** The loaders the page passes in. Both answer, and neither throws. */
export interface FundPositionsProps {
  /** The default view, as the server rendered it: the two newest snapshot dates. */
  initial: FundPositionChangesPage;
  loadPositions: (input: { from: string; to: string }) => Promise<FundPositionChangesPage>;
  loadSeries: (input: { stockCode: string }) => Promise<StockFundSeriesPage>;
}

/**
 * How long the slider waits for the handles to settle before it asks. A drag
 * moves the handles live but sends one request for where it came to rest.
 */
const MOVE_IDLE_MS = 250;

const SERIES_OUTAGE =
  "The fund files for this stock could not be read just now. Nothing here is missing from the register: this is our end.";

export function FundPositions(props: FundPositionsProps) {
  return (
    <Suspense fallback={<FundPositionsView page={props.initial} />}>
      <LiveFundPositions {...props} />
    </Suspense>
  );
}

/** Writes the pair into the link and leaves every other parameter as it is. The default pair is no parameter. */
function writeLink(from: string, to: string, initial: FundPositionChangesPage): void {
  const current = readDeskState(new URLSearchParams(window.location.search));
  const atDefault = from === initial.from && to === initial.to;
  const query = writeDeskState({ ...current, from: atDefault ? "" : from, to: atDefault ? "" : to });
  // A null state, never the current one: Next stamps its own entries, and a replaceState that carries them skips the router's update.
  window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
}

function LiveFundPositions({ initial, loadPositions, loadSeries }: FundPositionsProps) {
  const searchParams = useSearchParams();
  const [start] = useState(() => readDeskState(new URLSearchParams(searchParams?.toString() ?? "")));

  const [page, setPage] = useState<FundPositionChangesPage>(initial);
  const [chosen, setChosen] = useState({ from: initial.from, to: initial.to });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  // The last pair the API answered with, so a failed move leaves the slider where the data is.
  const answered = useRef({ from: initial.from, to: initial.to });
  const sequence = useRef(0);
  // The move waiting for the handles to settle, if any.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selected, setSelected] = useState<{ code: string; name: string } | null>(null);
  const [series, setSeries] = useState<StockFundSeriesPage | null>(null);
  const [seriesFailure, setSeriesFailure] = useState("");
  const [seriesBusy, setSeriesBusy] = useState(false);
  const seriesSequence = useRef(0);

  const request = useCallback(
    (range: { from: string; to: string }) => {
      const ticket = (sequence.current += 1);
      setChosen(range);
      setBusy(true);
      // The loaders never throw (an outage is ok: false), so the chain has no rejection to handle.
      void loadPositions(range).then((next) => {
        if (sequence.current !== ticket) return;
        setBusy(false);
        // A handle that is still moving keeps its place: only a settled pair is put back.
        const settled = pending.current === null;
        if (!next.ok) {
          setFailure(next.error || FUND_POSITIONS_OUTAGE);
          if (settled) setChosen(answered.current);
          // The link names the pair the rows on screen are for, so a bad one from the URL is dropped.
          writeLink(answered.current.from, answered.current.to, initial);
          return;
        }
        setFailure("");
        setPage(next);
        answered.current = { from: next.from, to: next.to };
        if (settled) setChosen(answered.current);
        writeLink(next.from, next.to, initial);
      });
    },
    [initial, loadPositions],
  );

  useEffect(
    () => () => {
      if (pending.current !== null) clearTimeout(pending.current);
    },
    [],
  );

  // A link that names a pair other than the default is asked for once, on mount.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (start.from === "" || start.to === "") return;
    if (start.from === initial.from && start.to === initial.to) return;
    request({ from: start.from, to: start.to });
  }, [start, initial, request]);

  // The handles follow the pointer at once; the request waits until they stop.
  const onRange = useCallback(
    (from: string, to: string) => {
      setChosen({ from, to });
      if (pending.current !== null) clearTimeout(pending.current);
      pending.current = setTimeout(() => {
        pending.current = null;
        request({ from, to });
      }, MOVE_IDLE_MS);
    },
    [request],
  );

  const choose = useCallback(
    (code: string) => {
      const row = page.rows.find((r) => r.code === code);
      if (selected?.code === code) {
        seriesSequence.current += 1;
        setSelected(null);
        setSeries(null);
        setSeriesFailure("");
        setSeriesBusy(false);
        return;
      }
      const ticket = (seriesSequence.current += 1);
      setSelected({ code, name: row?.name ?? "" });
      setSeries(null);
      setSeriesFailure("");
      setSeriesBusy(true);
      void loadSeries({ stockCode: code }).then((next) => {
        if (seriesSequence.current !== ticket) return;
        setSeriesBusy(false);
        if (next.ok) setSeries(next);
        else setSeriesFailure(next.error || SERIES_OUTAGE);
      });
    },
    [loadSeries, page.rows, selected],
  );

  // A stock's fund files load through the shared status row, not a line of their own in the panel.
  let panel: ReactNode = undefined;
  if (selected && !seriesBusy) {
    if (seriesFailure) panel = <p className="text-sm text-muted-foreground">{seriesFailure}</p>;
    else if (series) panel = <FundStockPanel code={selected.code} name={selected.name} funds={series.funds} />;
  }

  const status = busy || seriesBusy ? "Loading…" : failure || undefined;

  return (
    <FundPositionsView
      page={page}
      pair={chosen}
      onRange={onRange}
      selectedCode={selected?.code}
      onSelect={choose}
      status={status}
      panel={panel}
    />
  );
}
