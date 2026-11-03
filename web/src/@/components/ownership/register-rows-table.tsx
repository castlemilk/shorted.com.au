import { Fragment } from "react";
import Link from "next/link";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { kindInfo, kindRank, registerHref } from "~/@/lib/ownership/kinds";
import {
  serialiseRegisterParams,
  type RegisterSort,
  type RegistersQuery,
} from "~/@/lib/ownership/query";
import { POLITICS_FOCUS_RING } from "~/@/lib/politics/control-classes";
import { cn } from "~/@/lib/utils";
import { DisclosedBar, type DisclosedSegment } from "./disclosed-bar";
import { Dated } from "./ownership-provenance";

// Server-safe and client-safe: no "use client", no Connect import. The explorers
// draw it with the rows the action hands them: strings the server formatted, and
// the bar's numbers as numbers. The action declares its rows with these types.
//
// Three grammars, by the width the table is drawn in, and every value drawn once at each
// width. The wrapper is a container, so a grammar follows the table's own width and not the
// window's: a signed-in page's rail takes 256 px of the window. At the pinned cell sizes the
// seven columns need up to 967 px and the eleven up to 1,307 px (each the sum of the columns' narrowest
// widths, measured across every sort on the widest fixture), so 980 and 1,320 leave 13 px over each.
// Below 980 px a stock is two rows: the figures (the code, Disclosed, Short, Latest notice) and a full-width row
// holding the company name and a native details with the other measures. From 980 px the name moves under the code,
// and Institutions, Index funds and Super value become columns. From 1,320 px Interests,
// Banks and brokers, Hedge + active and Super options become columns too, and the full-width
// row is gone. A measure is a column at one width and a details entry at another: the two are
// separate elements, and container-query classes show only the one that belongs at a width.
// Cells take 4 px a side below sm, 8 px from sm and 12 px from xl. Those follow the window, as
// the screen's own spacing does. Dates never break, and a company name breaks anywhere below
// 980 px and truncates from it. The DisclosedBar sits on one scale for the whole table (the
// largest disclosed sum drawn): from md at 96 px, 128 px from xl, and its figure is always
// drawn beside it. A width too narrow for its columns scrolls the table sideways inside its
// wrapper: that is the fallback, not the layout.
//
// The chips and the sort heads of both explorers are links built here, so a
// reader without JavaScript gets the same links the islands write.

/** How long a request may be in flight before the screen says it is an outage. Both explorers hold the same figure. */
export const OUTAGE_AFTER_MS = 10_000;

/** What a list prints while a request it has no rows to dim is in flight: explorer.loading (section 7.1). */
export const LOADING_COPY = "Loading…";

/** One stock on the register, as the table prints it. */
export interface RegisterStockRow {
  code: string;
  companyName: string;
  industry: string;
  /** Interests counted once, as a count. */
  interests: string;
  /** The disclosed sum, formatted, or "n/a". */
  disclosed: string;
  /** The same sum as a number, for the bar. */
  disclosedPct: number;
  /** The sum by kind, for the bar's segments. */
  byKind: DisclosedSegment[];
  /** The investor kinds' sum, formatted, or "n/a". */
  institutions: string;
  banks: string;
  hedgeActive: string;
  index: string;
  /** The range the index figure is as at, "as at {from} to {to}", when the row carries it. */
  indexAsAt?: string;
  /** The count of super fund options that hold the stock, as a count. */
  superOptions: string;
  superValue: string;
  /** ASIC's latest short position, formatted, or "n/a". */
  short: string;
  /** The date of that short position, YYYY-MM-DD, when the row carries it. */
  shortAsOf?: string;
  /** The newest release date among the stock's notices, YYYY-MM-DD, or "" when none. */
  latestNotice: string;
}

/**
 * The grammar a measure is a table column in. Below it the row's details carry the measure: "seven" from the
 * seven-column grammar's width, "eleven" from the eleven-column grammar's.
 */
type ColumnFrom = "all" | "seven" | "eleven";

interface Column {
  sort: RegisterSort;
  label: string;
  align: "left" | "right";
  from: ColumnFrom;
}

const COLUMNS: readonly Column[] = [
  { sort: "code", label: "Stock", align: "left", from: "all" },
  { sort: "disclosed", label: "Disclosed", align: "right", from: "all" },
  { sort: "interests", label: "Interests", align: "right", from: "eleven" },
  { sort: "investors", label: "Institutions", align: "right", from: "seven" },
  { sort: "banks", label: "Banks, brokers", align: "right", from: "eleven" },
  { sort: "hedge_active", label: "Hedge + active", align: "right", from: "eleven" },
  { sort: "index", label: "Index funds", align: "right", from: "seven" },
  { sort: "super_options", label: "Super options", align: "right", from: "eleven" },
  { sort: "super_value", label: "Super value", align: "right", from: "seven" },
  { sort: "short", label: "Short", align: "right", from: "all" },
  { sort: "latest_notice", label: "Latest notice", align: "right", from: "all" },
];

/**
 * A column's classes: none for a column at every width, else a table cell from its grammar's width. The
 * widths are the table's own (its wrapper is the container): see the header for why they are not the window's.
 */
const SHOWN_FROM: Record<ColumnFrom, string> = {
  all: "",
  seven: "hidden [@container(min-width:980px)]:table-cell",
  eleven: "hidden [@container(min-width:1320px)]:table-cell",
};

/** A cell's padding: 4 px a side on a phone, 8 px from sm, 12 px from xl. The heads take the same. */
const CELL_PADDING = "px-1 sm:px-2 xl:px-3";

/** The outline the disclosed bar draws a hollow kind with, without its card-coloured gap. */
const HOLLOW_OUTLINE = "inset 0 0 0 1px hsl(var(--muted-foreground))";

/** A query string on a path, or the bare path when the query is the default. */
export function hrefWith(path: string, params: URLSearchParams): string {
  const search = params.toString();
  return search ? `${path}?${search}` : path;
}

/**
 * The link a sort head follows. Clicking the active head reverses it; a new head
 * sorts the way its measure is read: the code A to Z, every figure largest first.
 */
export function registerSortHref(basePath: string, query: RegistersQuery, sort: RegisterSort): string {
  const ascending = query.sort === sort ? !query.ascending : sort === "code";
  return hrefWith(basePath, serialiseRegisterParams({ ...query, sort, ascending, offset: 0 }));
}

/**
 * A kind's swatch as the disclosed bar draws it: "other" and every kind after it
 * have no colour of their own, so they are an outline, never a fill.
 */
export function KindSwatch({ kind }: { kind: string }) {
  const hollow = kindRank(kind) >= kindRank("other");
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block h-2 w-2 rounded-sm", !hollow && kindInfo(kind).swatch)}
      style={hollow ? { boxShadow: HOLLOW_OUTLINE } : undefined}
    />
  );
}

/**
 * A filter chip: a link, so it works before the island has loaded and after a
 * reload. Both explorers draw their chips here.
 */
export function FilterChip({
  href,
  active,
  label,
  count,
  kind,
  clearName,
}: {
  href: string;
  active: boolean;
  label: string;
  count?: number;
  /** A kind's swatch is drawn before the label. */
  kind?: string;
  /**
   * A chip that clears a filter rather than choosing one (the search text): its name says what a press
   * does, and it carries no aria-current, since it is not a choice the reader is in.
   */
  clearName?: string;
}) {
  return (
    <Link
      href={href}
      replace
      scroll={false}
      prefetch={false}
      rel="nofollow"
      aria-current={active && clearName === undefined ? "true" : undefined}
      aria-label={clearName}
      className={cn(
        "inline-flex h-9 items-center gap-2 rounded-md border px-3 text-xs transition-colors duration-150 motion-reduce:transition-none",
        POLITICS_FOCUS_RING,
        active
          ? "border-primary/60 bg-primary/10 font-semibold text-primary"
          : "border-border text-muted-foreground hover:border-input hover:text-foreground",
      )}
    >
      {kind !== undefined ? <KindSwatch kind={kind} /> : null}
      {label}
      {count !== undefined ? <span className="tabular-nums">{count}</span> : null}
    </Link>
  );
}

/** The figure a wide column or a detail line prints. */
function measure(row: RegisterStockRow, sort: RegisterSort): string {
  switch (sort) {
    case "interests":
      return row.interests;
    case "investors":
      return row.institutions;
    case "banks":
      return row.banks;
    case "hedge_active":
      return row.hedgeActive;
    case "index":
      return row.index;
    case "super_options":
      return row.superOptions;
    case "super_value":
      return row.superValue;
    case "short":
      return row.short;
    default:
      return "";
  }
}

function sortState(query: RegistersQuery, sort: RegisterSort): "ascending" | "descending" | "none" {
  if (query.sort !== sort) return "none";
  return query.ascending ? "ascending" : "descending";
}

function renderHead(column: Column, query: RegistersQuery, basePath: string) {
  const arrow = query.sort === column.sort ? (query.ascending ? "↑" : "↓") : "";
  return (
    <TableHead
      key={column.sort}
      aria-sort={sortState(query, column.sort)}
      className={cn(
        column.align === "right" ? "text-right" : "text-left",
        CELL_PADDING,
        "text-[11px] sm:text-sm",
        SHOWN_FROM[column.from],
      )}
    >
      <Link
        href={registerSortHref(basePath, query, column.sort)}
        replace
        scroll={false}
        prefetch={false}
        rel="nofollow"
        className={cn(
          "hit-target inline-flex items-center gap-1 rounded-sm hover:text-foreground",
          POLITICS_FOCUS_RING,
        )}
      >
        {column.label}
        {/* Only the sorted head draws an arrow: an empty span still takes the link's gap, and a phone's width is measured. */}
        {arrow ? <span aria-hidden="true">{arrow}</span> : null}
      </Link>
    </TableHead>
  );
}

function renderCell(column: Column, row: RegisterStockRow, scaleMax: number) {
  const sort = column.sort;
  if (sort === "code") {
    return (
      <TableCell key={sort} className={cn("min-w-0 align-top", CELL_PADDING)}>
        <Link
          href={registerHref(row.code)}
          prefetch={false}
          className="text-xs font-semibold text-primary underline-offset-4 hover:underline sm:text-sm"
        >
          {row.code}
        </Link>
        {/* From the seven-column grammar the name and the industry sit under the code. Below it the full-width row prints the name. */}
        {row.companyName ? (
          <span className="hidden text-xs text-muted-foreground [@container(min-width:980px)]:block [@container(min-width:980px)]:max-w-[14rem] [@container(min-width:980px)]:truncate">
            {row.companyName}
          </span>
        ) : null}
        {/* Capped at the name's width: the longest industry would otherwise set the Stock column, and it wraps within the cap. */}
        {industryLabel(row.industry) ? (
          <span className="hidden text-xs text-muted-foreground [@container(min-width:980px)]:block [@container(min-width:980px)]:max-w-[14rem]">
            {industryLabel(row.industry)}
          </span>
        ) : null}
      </TableCell>
    );
  }
  if (sort === "disclosed") {
    return (
      <TableCell key={sort} className={cn("whitespace-nowrap text-right tabular-nums", CELL_PADDING)}>
        <div className="flex items-center justify-end gap-3">
          <div className="hidden w-24 md:block xl:w-32">
            <DisclosedBar
              segments={row.byKind}
              total={row.disclosedPct}
              scaleMax={scaleMax}
              showFigure={false}
            />
          </div>
          <span>{row.disclosed}</span>
        </div>
      </TableCell>
    );
  }
  if (sort === "latest_notice") {
    return (
      <TableCell
        key={sort}
        className={cn("whitespace-nowrap text-right text-[11px] tabular-nums sm:text-sm", CELL_PADDING)}
      >
        {row.latestNotice ? (
          <time dateTime={row.latestNotice} className="whitespace-nowrap">
            {row.latestNotice}
          </time>
        ) : (
          NOT_AVAILABLE
        )}
      </TableCell>
    );
  }
  return (
    <TableCell key={sort} className={cn("text-right tabular-nums", CELL_PADDING, SHOWN_FROM[column.from])}>
      {measure(row, sort)}
      {/*
        A figure's date is printed under it, never held only in a title. The short line
        shows from the seven-column grammar (below it the row's details carry it); the index
        column is seven-column only, so its range always shows.
      */}
      {sort === "short" && row.shortAsOf ? (
        <span className="hidden text-[10px] text-muted-foreground [@container(min-width:980px)]:block">
          as of <time dateTime={row.shortAsOf} className="whitespace-nowrap">{row.shortAsOf}</time>
        </span>
      ) : null}
      {sort === "index" && row.indexAsAt ? (
        <span className="block text-[10px] text-muted-foreground">
          <Dated text={row.indexAsAt} timeClassName="whitespace-nowrap" />
        </span>
      ) : null}
    </TableCell>
  );
}

/**
 * The measures a stock's row does not draw at this width, and the industry and the short date a phone has
 * no column for, as a native details. RegisterRowsTable draws it in a full-width row under the stock's own
 * row, which is hidden from the eleven-column grammar, where the columns carry every measure. A measure that
 * is a column from the seven-column grammar is hidden here from that grammar, with its label.
 */
function renderDetails(row: RegisterStockRow) {
  return (
    <details className="text-xs">
      {/* A text-sized summary is 16 px tall; .hit-target gives it the 24 px floor (DESIGN.md's Two Floors Rule). */}
      <summary className="hit-target cursor-pointer text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground">
        More figures
        {/* The name a screen reader gets for this row's disclosure: fifty rows must not all read "More figures". */}
        <span className="sr-only"> for {row.code}</span>
      </summary>
      {/*
        Both tracks shrink to their content, and a figure breaks anywhere: a long label cannot widen the row. The
        list is capped at 24 rem from sm, so a label stays beside its figure on a desktop, where the row is wide.
      */}
      <dl className="mt-2 grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1 sm:max-w-sm">
        <dt className="text-muted-foreground [@container(min-width:980px)]:hidden">Industry</dt>
        <dd className="text-right [overflow-wrap:anywhere] [@container(min-width:980px)]:hidden">
          {industryLabel(row.industry) || NOT_AVAILABLE}
        </dd>
        {COLUMNS.filter((column) => column.from !== "all").map((column) => (
          <Fragment key={column.sort}>
            <dt
              className={cn(
                "text-muted-foreground",
                column.from === "seven" && "[@container(min-width:980px)]:hidden",
              )}
            >
              {column.label}
            </dt>
            <dd
              className={cn(
                "text-right tabular-nums [overflow-wrap:anywhere]",
                column.from === "seven" && "[@container(min-width:980px)]:hidden",
              )}
            >
              {measure(row, column.sort)}
              {column.sort === "index" && row.indexAsAt ? (
                <span className="block text-[11px] text-muted-foreground">
                  <Dated text={row.indexAsAt} timeClassName="whitespace-nowrap" />
                </span>
              ) : null}
            </dd>
          </Fragment>
        ))}
        {row.shortAsOf ? (
          <>
            <dt className="text-muted-foreground [@container(min-width:980px)]:hidden">Short</dt>
            <dd className="text-right tabular-nums [@container(min-width:980px)]:hidden">
              as of <time dateTime={row.shortAsOf} className="whitespace-nowrap">{row.shortAsOf}</time>
            </dd>
          </>
        ) : null}
      </dl>
    </details>
  );
}

/** The register's table: one row per stock, sorted as the query says. */
export function RegisterRowsTable({
  rows,
  query,
  basePath,
  caption,
}: {
  rows: readonly RegisterStockRow[];
  /** The sort, the direction and the filters the sort heads keep. */
  query: RegistersQuery;
  basePath: string;
  caption: string;
}) {
  // One scale for the table: the largest disclosed sum drawn, so the bars compare.
  const scaleMax = Math.max(0, ...rows.map((row) => row.disclosedPct));
  // The wrapper is the container the grammars read the width of. It is the table's own column, so it is as wide as the table may be.
  return (
    <div className="[container-type:inline-size]">
      <Table>
        <caption className="sr-only">{caption}</caption>
        <TableHeader>
          <TableRow>
            {COLUMNS.map((column) => renderHead(column, query, basePath))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <Fragment key={row.code}>
              {/*
                Below the eleven-column grammar the rule under a stock moves to its details row, so the two read as one
                block. From it the details row is hidden, so the last stock is the body's second-to-last child: it clears
                its own rule. The two rows take the hover tint together, each lighting when the other is hovered.
              */}
              <TableRow className="border-b-0 [@container(min-width:1320px)]:border-b [@container(min-width:1320px)]:[&:nth-last-child(2)]:border-b-0 [&:has(+tr:hover)]:bg-muted/50">
                {COLUMNS.map((column) => renderCell(column, row, scaleMax))}
              </TableRow>
              <TableRow className="[@container(min-width:1320px)]:hidden [tr:hover+&]:bg-muted/50">
                <TableCell colSpan={COLUMNS.length} className="px-1 pb-3 pt-0 sm:px-2 xl:px-3">
                  {row.companyName ? (
                    <p className="mb-1 text-xs text-muted-foreground [overflow-wrap:anywhere] [@container(min-width:980px)]:hidden">
                      {row.companyName}
                    </p>
                  ) : null}
                  {renderDetails(row)}
                </TableCell>
              </TableRow>
            </Fragment>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
