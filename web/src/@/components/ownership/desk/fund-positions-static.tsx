// Server-safe and client-safe: no "use client", no Connect import. The view the
// hub's server render draws, and the Suspense fallback of the live island, so the
// two are the same markup. Type imports of the loader's rows only.
//
// THE LISTS. Ten stocks rising in weight and ten falling, each a diverging bar
// on one centre line: a rise in amber, a fall in ink (the notice-flow palette,
// never red or green, since a fund's weight is not a market direction). A stock
// held on one of the two dates only sits in its own list, New or Dropped, and
// shows its one weight. It is never a change from zero.

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import type { FundPositionChangesPage, FundSeriesRow } from "~/app/actions/ownershipDesk";
import { ScreenReaderTable } from "~/@/components/politicians/explorer/screen-reader-table";
import { formatAmount, formatPct, NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { formatPointChange } from "~/@/lib/ownership/kinds";
import { sectionTitle } from "~/@/lib/typography";
import { cn } from "~/@/lib/utils";
import { DateSlider, shownSnapshotDates } from "./date-slider";
import { directionFill } from "./desk-scales";
import { FundSeries } from "./fund-series";
import { partitionFundChanges, type FundChangeRow } from "./fund-changes";

/** The caption the instrument prints under its lists (spec 13.5, verbatim). */
export const FUND_POSITIONS_CAPTION =
  "Index fund holdings files, one snapshot per file date; a weight is the fund's, not a share of the company. Super options disclose semi-annually.";

/** The lists' length: the default the loader asks for, and what the lists show. */
const LIST_LIMIT = 10;

/**
 * A move under the precision the lists print (0.00 pp) is no change: the stock
 * stays held at the same weight, so it is left out rather than drawn as a bar
 * that reads "0.00 pp".
 */
const MOVE_FLOOR_PP = 0.005;

/** The rows the compact pane draws in each list (backlog B2). */
export const COMPACT_ROWS = 5;

/** The line a read that did not answer prints in place of the window (spec 13.5). */
export const FUND_POSITIONS_OUTAGE =
  "The index fund files could not be read just now. Nothing here is missing from the register: this is our end.";

const ONE_FILE_DATE = "The tracked funds have one file date so far, so there is no change to draw yet.";
const NO_FILE_DATE = "No index fund file is tracked yet, so there is no window to draw.";

export interface FundPositionsViewProps {
  page: FundPositionChangesPage;
  /** The dates the slider shows. Absent: the page's own pair. */
  pair?: { from: string; to: string };
  /** A new pair from the slider. Absent: the slider is read-only (the server's view). */
  onRange?: (from: string, to: string) => void;
  /** The stock whose panel is open, by code. */
  selectedCode?: string;
  /** A stock's code was pressed. Absent: the codes are plain text. */
  onSelect?: (code: string) => void;
  /**
   * A line under the slider: the loading line, or an outage, or a refusal. It sits
   * in a row that is always mounted, so a line coming and going moves nothing.
   */
  status?: ReactNode;
  /** The open stock's panel, drawn beside the lists from `lg`. */
  panel?: ReactNode;
  /**
   * `compact` is the Overview's pane (backlog B2): the title links to the map's index lens, the lists are the
   * five largest rises beside the five largest falls, with no date slider and no caption. Absent is the full instrument.
   */
  variant?: "compact" | "full";
}

/** The changes between the two dates, in the four lists the instrument draws. */
export function fundPositionLists(rows: readonly FundChangeRow[]) {
  const moved = rows.filter(
    (row) => row.state !== "current" || row.delta === null || Math.abs(row.delta) >= MOVE_FLOOR_PP,
  );
  return partitionFundChanges(moved, LIST_LIMIT);
}

/** The largest change either list shows: the scale of the diverging bars. */
export function fundPositionReach(lists: ReturnType<typeof fundPositionLists>): number {
  return [...lists.rises, ...lists.falls].reduce((top, row) => Math.max(top, Math.abs(row.delta ?? 0)), 0);
}

/**
 * The AUD change of a stock across the funds, estimated: the value on the later
 * date less the value on the earlier. Null when either date has no value.
 */
export function valueChange(row: FundChangeRow): number | null {
  if (row.valueFrom === null || row.valueTo === null) return null;
  if (!Number.isFinite(row.valueFrom) || !Number.isFinite(row.valueTo)) return null;
  return row.valueTo - row.valueFrom;
}

/** A signed AUD amount with a true minus and a plus: "+$12.3M", "−$4.1M". */
export function formatValueChange(delta: number | null): string {
  if (delta === null) return NOT_AVAILABLE;
  const text = formatAmount(delta, "AUD");
  // A rise under the printed precision reads "$0", which takes no sign.
  return delta > 0 && /[1-9]/.test(text) ? `+${text}` : text;
}

export function FundPositionsView({
  page,
  pair,
  onRange,
  selectedCode,
  onSelect,
  status,
  panel,
  variant = "full",
}: FundPositionsViewProps) {
  const compact = variant === "compact";
  // The pane's title is the link to the map's index lens on the Overview, and the instrument's own title otherwise.
  const heading = compact ? (
    <Link href="/ownership/map?lens=index_flow" prefetch={false} className="underline-offset-4 hover:underline">
      Index fund positions
    </Link>
  ) : (
    "Index fund positions"
  );
  const statusLine = (
    <div role="status" aria-live="polite" className="min-h-[1.25rem] text-sm text-muted-foreground">
      {status}
    </div>
  );

  // A read that did not answer is not a window with no change in it: it says so, and draws nothing else.
  if (!page.ok) {
    return (
      <section className="space-y-4">
        <h2 className={sectionTitle}>{heading}</h2>
        <p className="text-sm text-muted-foreground">{page.error || FUND_POSITIONS_OUTAGE}</p>
        {statusLine}
      </section>
    );
  }

  const lists = fundPositionLists(page.rows);
  const reach = fundPositionReach(lists);
  // The dates the slider shows, so the caption and the handles name one window.
  const shown = shownSnapshotDates(page.snapshotDates, pair?.from ?? page.from, pair?.to ?? page.to);
  const hasRange = page.snapshotDates.length >= 2;
  const empty = lists.rises.length + lists.falls.length + lists.added.length + lists.dropped.length === 0;
  const rangeText = shown.from && shown.to ? `From ${shown.from} to ${shown.to}` : NOT_AVAILABLE;

  return (
    <section className="space-y-4">
      <h2 className={sectionTitle}>{heading}</h2>

      {hasRange && !compact ? (
        <DateSlider
          dates={page.snapshotDates}
          from={shown.from}
          to={shown.to}
          label="Snapshot dates of the index fund window"
          onChange={onRange}
        />
      ) : hasRange ? null : (
        <p className="text-sm text-muted-foreground">
          {page.snapshotDates.length === 1 ? ONE_FILE_DATE : NO_FILE_DATE}
        </p>
      )}
      {hasRange ? <p className="text-sm tabular-nums">{rangeText}</p> : null}

      {compact ? null : statusLine}

      {compact ? (
        <div className="grid gap-6 sm:grid-cols-2">
          {empty && hasRange ? (
            <p className="text-sm text-muted-foreground sm:col-span-2">No stock&apos;s weight moved between these two dates.</p>
          ) : null}
          <ChangeList
            compact
            title="Rises in weight"
            rows={lists.rises.slice(0, COMPACT_ROWS)}
            reach={reach}
            selectedCode={selectedCode}
            onSelect={onSelect}
          />
          <ChangeList
            compact
            title="Falls in weight"
            rows={lists.falls.slice(0, COMPACT_ROWS)}
            reach={reach}
            selectedCode={selectedCode}
            onSelect={onSelect}
          />
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="space-y-6">
            {empty && hasRange ? (
              <p className="text-sm text-muted-foreground">No stock&apos;s weight moved between these two dates.</p>
            ) : null}
            <ChangeList
              title="Rises in weight"
              rows={lists.rises}
              reach={reach}
              selectedCode={selectedCode}
              onSelect={onSelect}
            />
            <ChangeList
              title="Falls in weight"
              rows={lists.falls}
              reach={reach}
              selectedCode={selectedCode}
              onSelect={onSelect}
            />
            <HeldOnlyList title="New" rows={lists.added} selectedCode={selectedCode} onSelect={onSelect} />
            <HeldOnlyList title="Dropped" rows={lists.dropped} selectedCode={selectedCode} onSelect={onSelect} />
          </div>
          {/* The column is reserved once a stock is chosen, so its panel arrives without moving the lists. */}
          {selectedCode !== undefined || panel ? <aside className="min-w-0 space-y-3">{panel}</aside> : null}
        </div>
      )}

      {compact ? null : <p className="text-[11px] text-muted-foreground">{FUND_POSITIONS_CAPTION}</p>}

      <ScreenReaderTable ariaLabel="Index fund weight changes between the two dates">
        <caption>Index fund weight changes between the two dates, as the lists above show them.</caption>
        <thead>
          <tr>
            <th scope="col">Stock</th>
            <th scope="col">State</th>
            <th scope="col">Weight, earlier date</th>
            <th scope="col">Weight, later date</th>
            <th scope="col">Change in weight</th>
            <th scope="col">AUD change, estimated</th>
            <th scope="col">Funds</th>
          </tr>
        </thead>
        <tbody>
          {[...lists.rises, ...lists.falls, ...lists.added, ...lists.dropped].map((row) => (
            <tr key={row.code}>
              <th scope="row">{`${row.code} ${row.name}`}</th>
              <td>{row.state === "current" ? "Held on both dates" : row.state === "new" ? "New" : "Dropped"}</td>
              <td className="tabular-nums">{formatPct(row.weightFrom, { digits: 2 })}</td>
              <td className="tabular-nums">{formatPct(row.weightTo, { digits: 2 })}</td>
              <td className="tabular-nums">
                {row.delta === null ? NOT_AVAILABLE : formatPointChange(0, row.delta)}
              </td>
              <td className="tabular-nums">{formatValueChange(valueChange(row))}</td>
              <td className="tabular-nums">{row.funds}</td>
            </tr>
          ))}
        </tbody>
      </ScreenReaderTable>
    </section>
  );
}

interface ChangeListProps {
  title: string;
  rows: readonly FundChangeRow[];
  reach: number;
  selectedCode?: string;
  onSelect?: (code: string) => void;
  /** The Overview's pane: no AUD column. */
  compact?: boolean;
}

/** One diverging list: the rises or the falls, each row a bar from the centre line. */
function ChangeList({ title, rows, reach, selectedCode, onSelect, compact = false }: ChangeListProps) {
  if (rows.length === 0) return null;
  // The compact pane has no AUD column: its row is the name, the bar and the change.
  const rowGrid = compact
    ? "grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)_4.5rem]"
    : "grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_4.5rem_5.5rem]";
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1">
        <h3 className="text-xs text-muted-foreground">{title}</h3>
        {compact ? null : (
          <p className="text-[11px] text-muted-foreground">
            <span className="sr-only">Change in weight, percentage points. </span>
            <span className="tabular-nums">AUD change, estimated</span>
          </p>
        )}
      </div>
      <ul className="space-y-1.5">
        {rows.map((row) => {
          const delta = row.delta ?? 0;
          const rise = delta > 0;
          const width = reach > 0 ? (Math.abs(delta) / reach) * 50 : 0;
          const bar: CSSProperties = {
            width: `${width}%`,
            background: directionFill(rise ? "up" : "down"),
            ...(rise ? { left: "50%" } : { right: "50%" }),
          };
          return (
            <li key={row.code} className={cn("grid items-center gap-x-3 text-sm", rowGrid)}>
              <StockName row={row} selected={row.code === selectedCode} onSelect={onSelect} />
              <div className="relative h-3" aria-hidden="true">
                <div className="absolute inset-y-0 left-1/2 w-px bg-border" />
                <div className="absolute inset-y-0 rounded-[2px]" style={bar} />
              </div>
              <span className="whitespace-nowrap text-right tabular-nums">{formatPointChange(0, delta)}</span>
              {compact ? null : (
                <span className="text-right text-xs tabular-nums text-muted-foreground">
                  {formatValueChange(valueChange(row))}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

interface HeldOnlyListProps {
  title: string;
  rows: readonly FundChangeRow[];
  selectedCode?: string;
  onSelect?: (code: string) => void;
}

/** New or dropped stocks: one weight each, on the date they are held. No change is drawn. */
function HeldOnlyList({ title, rows, selectedCode, onSelect }: HeldOnlyListProps) {
  if (rows.length === 0) return null;
  const isNew = title === "New";
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-1">
        <h3 className="text-xs text-muted-foreground">{title}</h3>
        <p className="text-[11px] text-muted-foreground">
          {isNew ? "Weight on the later date" : "Weight on the earlier date"}
          <span className="ml-3 tabular-nums">AUD value, estimated</span>
        </p>
      </div>
      <ul className="space-y-1.5">
        {rows.map((row) => (
          <li key={row.code} className="grid grid-cols-[minmax(0,7.5rem)_minmax(0,1fr)_4.5rem_5.5rem] items-center gap-x-3 text-sm">
            <StockName row={row} selected={row.code === selectedCode} onSelect={onSelect} />
            <span />
            <span className="text-right tabular-nums">
              {formatPct(isNew ? row.weightTo : row.weightFrom, { digits: 2 })}
            </span>
            <span className="text-right text-xs tabular-nums text-muted-foreground">
              {formatAmount(isNew ? row.valueTo : row.valueFrom, "AUD")}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function StockName({
  row,
  selected,
  onSelect,
}: {
  row: FundChangeRow;
  selected: boolean;
  onSelect?: (code: string) => void;
}) {
  const label = (
    <>
      <span className="font-medium text-foreground">{row.code}</span>{" "}
      <span className="text-xs text-muted-foreground">{row.name}</span>
    </>
  );
  if (!onSelect) return <span className="min-w-0 truncate">{label}</span>;
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(row.code)}
      className={cn(
        "min-w-0 truncate rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected && "underline underline-offset-4",
      )}
    >
      {label}
    </button>
  );
}

export interface FundStockPanelProps {
  code: string;
  name: string;
  funds: readonly FundSeriesRow[];
}

/** The open stock: its name, and each tracked fund's weight over the file dates. */
export function FundStockPanel({ code, name, funds }: FundStockPanelProps) {
  return (
    <section className="space-y-3 border-t border-border pt-3">
      <h3 className="text-sm">
        <span className="font-medium text-foreground">{code}</span>{" "}
        <span className="text-muted-foreground">{name}</span>
      </h3>
      {funds.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No index fund file or super option disclosure tracked holds {code}.
        </p>
      ) : (
        <FundSeries funds={funds} />
      )}
    </section>
  );
}
