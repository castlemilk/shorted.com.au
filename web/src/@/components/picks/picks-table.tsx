import { Fragment } from "react";
import Link from "next/link";

import { cn } from "~/@/lib/utils";
import {
  NOT_AVAILABLE,
  formatMultiple,
  formatPct,
  formatPrice,
  formatScore,
  formatSigned,
} from "~/@/lib/strategies/format";
import { STATUS_LABELS } from "~/@/lib/strategies/shortlist";
import { pickSortDef, type PickSortKey } from "~/@/lib/strategies/sort";
import type {
  PickRow,
  PickStatus,
  RuleResultRow,
  RuleStatus,
} from "~/@/lib/strategies/types";
import {
  GrowthCellValue,
  PickFundamentalsDetails,
  SortedByValue,
  pickGrowthFigures,
} from "./pick-fundamentals";

/**
 * The ranked picks table: the server-rendered sibling of ShortInterestTable.
 *
 * Props-only and hook-free, so it renders in the ISR HTML (where crawlers read
 * it) AND inside the sort client island without dragging anything server-only
 * across the boundary. Every numeral is tabular and right-aligned; a value the
 * data does not have renders "n/a", never 0.
 *
 * StatusPill is also the stock page's Strategy fit strip's
 * (components/stocks/strategy-fit-strip.tsx): keep its props, keep it
 * hook-free, and keep this file clear of ~/gen and @connectrpc.
 */

/** The strategy's rules in order: the dots follow this order. */
export interface RuleColumn {
  id: string;
  title: string;
  /**
   * Must pass for status "triggered"; a scoring-only rule reads muted in the
   * legend's key. Absent (an older caller) draws every rule as core.
   */
  core?: boolean;
}

const STATUS_WORD: Record<RuleStatus, string> = {
  pass: "pass",
  fail: "fail",
  unknown: "unknown",
};

/**
 * A status as an indicator lamp: lit (triggered, every core rule passes),
 * armed (setup, hollow amber: only the trigger is missing) or standby
 * (watch, hollow muted). Square, so it is never mistaken for the round rule
 * dots; decorative, so the word beside it stays the carrier of meaning.
 */
export function StatusLamp({ status }: { status: PickStatus }) {
  return (
    <span
      aria-hidden="true"
      data-status-lamp={status}
      className={cn(
        "h-1.5 w-1.5 shrink-0 rounded-[1px]",
        status === "triggered" && "bg-primary",
        status === "setup" && "border border-primary/70",
        status === "watch" && "border border-muted-foreground/60",
      )}
    />
  );
}

export function StatusPill({ status }: { status: PickStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-0.5 text-[11px] font-medium uppercase leading-none tracking-[0.12em]",
        status === "triggered" && "border-primary/50 bg-primary/10 text-primary",
        status === "setup" && "border-input text-foreground",
        status === "watch" && "border-border text-muted-foreground",
      )}
    >
      <StatusLamp status={status} />
      {STATUS_LABELS[status]}
    </span>
  );
}

/** One rule outcome as a dot: filled amber, hollow, or dashed. */
export function RuleDot({ status }: { status: RuleStatus }) {
  return (
    <span
      aria-hidden="true"
      data-rule-status={status}
      className={cn(
        "block h-2.5 w-2.5 rounded-full border",
        status === "pass" && "border-primary bg-primary",
        status === "fail" && "border-input bg-transparent",
        status === "unknown" && "border-dashed border-muted-foreground bg-transparent",
      )}
    />
  );
}

function ruleLabel(index: number, title: string, result: RuleResultRow | undefined) {
  const status = result?.status ?? "unknown";
  const detail = result?.detail ? `. ${result.detail}` : "";
  return `${index + 1}. ${title}: ${STATUS_WORD[status]}${detail}`;
}

export function RuleDots({
  rules,
  results,
}: {
  rules: RuleColumn[];
  results: RuleResultRow[];
}) {
  const byId = new Map(results.map((result) => [result.ruleId, result]));
  return (
    <ul className="flex items-center" aria-label="Rule results">
      {rules.map((rule, index) => {
        const result = byId.get(rule.id);
        const label = ruleLabel(index, rule.title, result);
        return (
          <li key={rule.id}>
            {/* The padding widens the hover target for the tooltip without
                changing the drawn size of the dot. */}
            <span title={label} className="block p-[3px]">
              <RuleDot status={result?.status ?? "unknown"} />
            </span>
            <span className="sr-only">{label}</span>
          </li>
        );
      })}
    </ul>
  );
}

function NumCell({
  children,
  className,
  title,
}: {
  children: React.ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <td
      title={title}
      className={cn("whitespace-nowrap px-3 py-2 text-right tabular-nums", className)}
    >
      {children}
    </td>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-muted-foreground">{children}</span>;
}

/** A formatted value, dimmed when it is "n/a". */
function Value({ text }: { text: string }) {
  return text === NOT_AVAILABLE ? <Muted>{text}</Muted> : <>{text}</>;
}

function formatBase(row: PickRow): string {
  if (row.baseLengthDays === null || row.baseDepthPct === null) {
    return NOT_AVAILABLE;
  }
  return `${formatPct(row.baseDepthPct)} · ${row.baseLengthDays}d`;
}

const TH = "whitespace-nowrap px-3 py-2 font-medium";
const TH_NUM = cn(TH, "text-right");
const HINT = "cursor-help underline decoration-dotted underline-offset-4";

/** Columns before any "Sorted by" column: the empty row spans them all. */
export const BASE_COLUMN_COUNT = 13;

const REVENUE_HINT =
  "Revenue on the same span a year earlier. TTM: trailing 12 months; FY: full year; HY: half year. F marks a figure from a company filing. n/m: beyond +500% or below −95%.";
const EPS_HINT =
  "Earnings per share on the same span a year earlier. TTM: trailing 12 months; FY: full year; HY: half year. F marks a figure from a company filing. n/m: beyond +500% or below −95%.";

export interface PicksTableProps {
  rows: PickRow[];
  rules: RuleColumn[];
  /** Screen-reader caption: the page's own H1 text. */
  caption: string;
  /** Shown in a single row when `rows` is empty. */
  emptyMessage?: string;
  /**
   * The API reports which stocks hold fundamentals (fundamentalsHeld), so the
   * Stock cell carries the fundamentals disclosure, including "No
   * fundamentals held" for a row without any. False renders the table as an
   * API without StrategyPick.fundamentals always did.
   */
  showFundamentals?: boolean;
  /**
   * The active sort. A metric the table has no column for adds one
   * right-aligned "Sorted by" column; Rev YoY and EPS YoY are marked instead,
   * and shown at every width.
   */
  sortKey?: PickSortKey | null;
  /** A sort is loading: the rows are dimmed and the region is aria-busy. */
  busy?: boolean;
}

function ariaSort(key: PickSortKey | null | undefined, column: PickSortKey) {
  if (key !== column) return undefined;
  return pickSortDef(key).ascending ? "ascending" : "descending";
}

export function PicksTable({
  rows,
  rules,
  caption,
  emptyMessage,
  showFundamentals = false,
  sortKey = null,
  busy = false,
}: PicksTableProps) {
  const sortDef = sortKey ? pickSortDef(sortKey) : null;
  const sortColumn = sortDef && !sortDef.hasColumn ? sortDef : null;
  const revenueCell = sortKey === "revenue_yoy" ? "" : "hidden lg:table-cell";
  const epsCell = sortKey === "eps_yoy" ? "" : "hidden lg:table-cell";
  return (
    <div
      aria-busy={busy || undefined}
      className={cn(
        "overflow-x-auto rounded-lg border border-border/60 transition-opacity",
        busy && "opacity-50",
      )}
    >
      <table className="w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <th scope="col" className={TH_NUM}>
              <span className="sr-only">Rank</span>
              <span aria-hidden="true">#</span>
            </th>
            <th scope="col" className={TH}>
              Stock
            </th>
            <th scope="col" className={TH}>
              Status
            </th>
            <th scope="col" className={cn(TH_NUM, "hidden sm:table-cell")}>
              <span className={HINT} title="0 to 100; orders stocks within a status">
                Score
              </span>
            </th>
            <th scope="col" className={TH}>
              Rules
            </th>
            <th scope="col" className={TH_NUM}>
              Close
            </th>
            <th scope="col" className={TH_NUM}>
              <span className={HINT} title="Breakout level; back below it is the exit">
                Pivot
              </span>
            </th>
            <th scope="col" className={cn(TH_NUM, "hidden md:table-cell")}>
              <span
                className={HINT}
                title="Base depth, high to low, and its length in sessions"
              >
                Base
              </span>
            </th>
            <th scope="col" className={cn(TH_NUM, "hidden md:table-cell")}>
              <span
                className={HINT}
                title="Latest volume as a multiple of the 50-day average"
              >
                Vol
              </span>
            </th>
            <th
              scope="col"
              aria-sort={ariaSort(sortKey, "revenue_yoy")}
              className={cn(TH_NUM, revenueCell)}
            >
              <span className={HINT} title={REVENUE_HINT}>
                Rev YoY
              </span>
            </th>
            <th
              scope="col"
              aria-sort={ariaSort(sortKey, "eps_yoy")}
              className={cn(TH_NUM, epsCell)}
            >
              <span className={HINT} title={EPS_HINT}>
                EPS YoY
              </span>
            </th>
            <th scope="col" className={cn(TH_NUM, "hidden lg:table-cell")}>
              <span
                className={HINT}
                title="3-month return minus the S&P/ASX 200 return, in percentage points"
              >
                RS 3m
              </span>
            </th>
            <th scope="col" className={cn(TH_NUM, "hidden sm:table-cell")}>
              <span
                className={HINT}
                title="Reported short position as a share of the company's shares on issue (ASIC, T+4)"
              >
                Short
              </span>
            </th>
            {sortColumn ? (
              <th
                scope="col"
                aria-sort={sortColumn.ascending ? "ascending" : "descending"}
                className={cn(TH_NUM, "text-foreground")}
              >
                <span className="sr-only">Sorted by </span>
                <span className={HINT} title={sortColumn.title}>
                  {sortColumn.label}
                </span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.length === 0 ? (
            <tr>
              <td
                colSpan={BASE_COLUMN_COUNT + (sortColumn ? 1 : 0)}
                className="px-3 py-6 text-center text-muted-foreground"
              >
                {emptyMessage ?? "No stocks meet this strategy's rules today."}
              </td>
            </tr>
          ) : (
            rows.map((row) => {
              const [revenue, eps] = pickGrowthFigures(row);
              return (
                <tr
                  key={row.code}
                  data-status={row.status}
                  className="transition-colors duration-150 hover:bg-muted/30 motion-reduce:transition-none"
                >
                  <NumCell className="text-muted-foreground">{row.rank}</NumCell>
                  <td className="px-3 py-2">
                    <Link
                      href={`/shorts/${row.code}`}
                      prefetch={false}
                      className="font-semibold text-primary hover:underline"
                    >
                      {row.code}
                    </Link>
                    {row.name ? (
                      <span className="hidden max-w-[220px] truncate text-xs text-muted-foreground sm:block">
                        {row.name}
                      </span>
                    ) : null}
                    {showFundamentals ? <PickFundamentalsDetails row={row} /> : null}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <StatusPill status={row.status} />
                  </td>
                  <NumCell className="hidden sm:table-cell">
                    {formatScore(row.score)}
                  </NumCell>
                  <td className="px-3 py-2">
                    <RuleDots rules={rules} results={row.rules} />
                  </td>
                  <NumCell>
                    <Value text={formatPrice(row.close)} />
                  </NumCell>
                  <NumCell>
                    <Value text={formatPrice(row.pivot)} />
                  </NumCell>
                  <NumCell className="hidden md:table-cell">
                    <Value text={formatBase(row)} />
                  </NumCell>
                  <NumCell className="hidden md:table-cell">
                    <Value text={formatMultiple(row.volumeRatio)} />
                  </NumCell>
                  <NumCell className={revenueCell} title={revenue.title || undefined}>
                    <GrowthCellValue figure={revenue} />
                  </NumCell>
                  <NumCell className={epsCell} title={eps.title || undefined}>
                    <GrowthCellValue figure={eps} />
                  </NumCell>
                  <NumCell className="hidden lg:table-cell">
                    <Value text={formatSigned(row.rs3mPct, "pp")} />
                  </NumCell>
                  <NumCell
                    className="hidden sm:table-cell"
                    title={
                      row.shortPct === null
                        ? "No reported ASIC short position"
                        : undefined
                    }
                  >
                    <Value text={formatPct(row.shortPct, 2)} />
                  </NumCell>
                  {sortColumn ? (
                    <NumCell className="font-medium">
                      <SortedByValue row={row} sortKey={sortColumn.key} />
                    </NumCell>
                  ) : null}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/**
 * What the dots mean, and which rule each position is. Sits above the table
 * so a reader never has to hover to decode a row.
 */
export function RuleLegend({ rules }: { rules: RuleColumn[] }) {
  return (
    <div className="space-y-1.5 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
        {(["pass", "fail", "unknown"] as const).map((status) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            <RuleDot status={status} />
            {status === "pass"
              ? "Pass"
              : status === "fail"
                ? "Fail"
                : "Unknown (data missing, or not meaningful for this company)"}
          </span>
        ))}
      </p>
      {rules.length > 0 ? (
        <p className="flex flex-wrap items-center gap-x-1 gap-y-1.5">
          <span className="mr-1">Dots follow the rule order:</span>
          {rules.map((rule, index) => (
            <Fragment key={rule.id}>
              {/* The key: each rule as a numbered node, joined by a hairline
                  segment, the same order the dots sit in. */}
              {index > 0 ? (
                <span aria-hidden="true" className="h-px w-3 shrink-0 bg-border" />
              ) : null}
              <span
                className={cn(
                  "inline-flex items-center gap-1.5 whitespace-nowrap",
                  rule.core === false && "text-muted-foreground",
                )}
              >
                {/* One index everywhere: this numeral is the nth dot in the
                    row and the nth entry in the strategy's rule list. A
                    scoring-only rule reads muted with a dashed ring. */}
                <span
                  aria-hidden="true"
                  className={cn(
                    "inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border text-[10px] leading-none tabular-nums",
                    rule.core === false
                      ? "border-dashed border-muted-foreground"
                      : "border-border text-foreground",
                  )}
                >
                  {index + 1}
                </span>
                <span className="sr-only">{index + 1}. </span>
                {rule.title}
                {rule.core === false ? (
                  <span className="sr-only"> (scoring only)</span>
                ) : null}
              </span>
            </Fragment>
          ))}
          <span className="ml-1">Hover a dot for the evidence.</span>
        </p>
      ) : null}
    </div>
  );
}
