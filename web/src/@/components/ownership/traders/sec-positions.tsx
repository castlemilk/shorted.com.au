import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import {
  adjacentQuarters,
  comparePositions,
} from "~/@/lib/ownership/quarterly-positions";
import { displayRecordDate } from "~/server/traders/profile-metadata";
import { sectionTitle } from "~/@/lib/typography";
import {
  edgarUrl,
  type Position,
  type Snapshot,
} from "~/server/traders/sec-filings";
import type {
  FilingPeriod,
  SecHoldings,
} from "~/server/traders/get-sec-holdings";

const number = new Intl.NumberFormat("en-AU");
const signed = new Intl.NumberFormat("en-AU", { signDisplay: "exceptZero" });
const linkStyle =
  "text-primary underline underline-offset-4 hover:decoration-2";

type ReportedPosition = { position: Position; change?: number };

function PositionsTable({
  rows,
  caption,
  showChange = false,
}: {
  rows: ReportedPosition[];
  caption: string;
  showChange?: boolean;
}) {
  const largestValue = rows.reduce(
    (largest, row) => Math.max(largest, row.position.usd),
    0,
  );
  return (
    <Table
      role="table"
      className="max-sm:block max-sm:[&_td]:p-0 max-sm:[&_th]:h-auto max-sm:[&_th]:p-0"
    >
      <caption className="sr-only">{caption}</caption>
      <TableHeader role="rowgroup" className="max-sm:block">
        <TableRow
          role="row"
          className="max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-3 max-sm:py-2"
        >
          <TableHead role="columnheader" scope="col">
            Security
          </TableHead>
          <TableHead
            role="columnheader"
            scope="col"
            className="text-right max-sm:sr-only"
          >
            Quantity
          </TableHead>
          {showChange && (
            <TableHead
              role="columnheader"
              scope="col"
              className="text-right max-sm:sr-only"
            >
              Change in quantity
            </TableHead>
          )}
          <TableHead
            role="columnheader"
            scope="col"
            className="text-right max-sm:col-start-2"
          >
            Value (US$)
            {largestValue > 0 && (
              <span className="block text-xs font-normal text-muted-foreground">
                Bar vs largest
              </span>
            )}
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody role="rowgroup" className="max-sm:block">
        {rows.map(({ position, change }) => {
          const units =
            position.unit === "PRN"
              ? "principal"
              : position.option
                ? "underlying shares"
                : "shares";
          return (
            <TableRow
              role="row"
              className="max-sm:grid max-sm:grid-cols-2 max-sm:items-baseline max-sm:gap-x-3 max-sm:gap-y-1.5 max-sm:py-3"
              key={`${position.cusip}:${position.unit}:${position.option}`}
            >
              <TableCell
                role="cell"
                className="max-sm:col-start-1 max-sm:row-start-1 max-sm:[overflow-wrap:anywhere]"
              >
                <span className="block font-medium">{position.issuer}</span>
                <span className="text-xs text-muted-foreground">
                  {position.securityClass}
                  {position.option &&
                    ` · ${position.option.toLowerCase()} option`}
                </span>
              </TableCell>
              <TableCell
                role="cell"
                className="text-right tabular-nums max-sm:col-start-1 max-sm:row-start-2 max-sm:text-left max-sm:text-xs max-sm:text-muted-foreground"
              >
                {number.format(position.quantity)}
                <span className="text-xs text-muted-foreground sm:block">
                  {" "}
                  {units}
                </span>
              </TableCell>
              {showChange && (
                <TableCell
                  role="cell"
                  className="text-right text-xs tabular-nums max-sm:col-start-2 max-sm:row-start-2 max-sm:text-muted-foreground"
                >
                  {change !== undefined && (
                    <span aria-hidden="true" className="sm:hidden">
                      Change{" "}
                    </span>
                  )}
                  {change === undefined
                    ? "This filing only"
                    : signed.format(change)}
                </TableCell>
              )}
              <TableCell
                role="cell"
                className="text-right tabular-nums max-sm:col-start-2 max-sm:row-start-1 max-sm:self-start max-sm:[overflow-wrap:anywhere]"
              >
                {number.format(position.usd)}
                {largestValue > 0 && (
                  <span
                    aria-hidden="true"
                    className="ml-auto mt-1 block h-1 w-16 max-w-full bg-border/70 sm:w-20"
                  >
                    <span
                      className="block h-full bg-primary/70"
                      style={{
                        width: `${(position.usd / largestValue) * 100}%`,
                      }}
                    />
                  </span>
                )}
                {position.option && (
                  <span className="block text-xs text-muted-foreground">
                    {position.unit === "PRN"
                      ? "Underlying security value"
                      : "Underlying share value"}
                  </span>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

function Positions({
  snapshot,
  previous,
}: {
  snapshot: Snapshot;
  previous?: Snapshot;
}) {
  const currentRows: ReportedPosition[] = [];
  const priorOnly: ReportedPosition[] = [];
  for (const { current, previous: before } of comparePositions(
    snapshot,
    previous,
  )) {
    if (current) {
      currentRows.push({
        position: current,
        change: before ? current.quantity - before.quantity : undefined,
      });
    } else if (before) {
      priorOnly.push({ position: before });
    }
  }
  const sum = snapshot.positions.reduce((total, row) => total + row.usd, 0);
  const currentId = `positions-${snapshot.filing.period}`;
  const priorId =
    previous &&
    `previous-only-${previous.filing.period}-to-${snapshot.filing.period}`;
  return (
    <>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] items-end gap-x-4 border-y py-3">
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">
            Value on filing cover
          </dt>
          <dd className="mt-1 text-lg font-medium leading-tight tabular-nums [overflow-wrap:anywhere] sm:text-3xl">
            <span className="mr-1 text-sm text-muted-foreground">US$</span>
            <wbr />
            {number.format(snapshot.totalUsd)}
          </dd>
        </div>
        <div className="text-right">
          <dt className="text-xs text-muted-foreground">Entries filed</dt>
          <dd className="mt-1 text-lg font-medium leading-tight tabular-nums sm:text-2xl">
            {snapshot.positions.length}
          </dd>
        </div>
      </dl>
      {sum !== snapshot.totalUsd && (
        <details className="text-sm text-muted-foreground">
          <summary className="min-h-6 cursor-pointer text-xs leading-6">
            Cover and rows differ by US$
            {number.format(Math.abs(sum - snapshot.totalUsd))}
          </summary>
          <p className="pt-1">
            The position rows total US${number.format(sum)}. The cover reports
            US${number.format(snapshot.totalUsd)}.
          </p>
        </details>
      )}
      {snapshot.confidentialOmitted && (
        <p className="text-sm text-muted-foreground">
          The manager marked holdings as confidentially omitted.
        </p>
      )}
      {previous && (
        <div className="flex flex-wrap items-center justify-between gap-x-2 text-xs">
          <p className="text-muted-foreground">
            <span className="sm:hidden">Since</span>
            <span className="hidden sm:inline">Change since</span>{" "}
            <time dateTime={previous.filing.period}>
              {displayRecordDate(previous.filing.period)}
            </time>
          </p>
          {priorOnly.length > 0 && (
            <a
              href={`#${priorId}`}
              className={`inline-flex min-h-10 items-center ${linkStyle}`}
            >
              {priorOnly.length} previous-only{" "}
              {priorOnly.length === 1 ? "position" : "positions"} ↓
            </a>
          )}
        </div>
      )}
      <div id={currentId} tabIndex={-1} className="scroll-mt-32">
        <PositionsTable
          rows={currentRows}
          caption={`${snapshot.manager} positions reported for ${snapshot.filing.period}`}
          showChange={!!previous}
        />
      </div>
      {previous && priorOnly.length > 0 && (
        <details className="border-t">
          <summary className="min-h-10 cursor-pointer py-3 text-sm font-medium">
            Only in the previous filing ({priorOnly.length})
          </summary>
          <div id={priorId} tabIndex={-1} className="scroll-mt-32 space-y-2">
            <h3 className="text-base font-semibold">
              Positions only in the previous filing
            </h3>
            <p className="text-xs leading-relaxed text-muted-foreground">
              Reported on{" "}
              <time dateTime={previous.filing.period}>
                {displayRecordDate(previous.filing.period)}
              </time>
              {" and absent from the "}
              <time dateTime={snapshot.filing.period}>
                {displayRecordDate(snapshot.filing.period)}
              </time>{" "}
              filing.
            </p>
            <PositionsTable
              rows={priorOnly}
              caption={`Positions reported only in the previous filing, ${previous.filing.period}`}
            />
            <a
              href={`#${currentId}`}
              className={`inline-flex min-h-10 items-center text-sm ${linkStyle}`}
            >
              Back to current positions ↑
            </a>
          </div>
        </details>
      )}
    </>
  );
}

function Period({
  cik,
  period,
  previous,
  showQuarter = false,
}: {
  cik: string;
  period: FilingPeriod;
  previous?: Snapshot;
  showQuarter?: boolean;
}) {
  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-4">
        {showQuarter && (
          <h3 className="text-sm font-medium">
            Quarter ended{" "}
            <time dateTime={period.filings[0]!.period}>
              {displayRecordDate(period.filings[0]!.period)}
            </time>
          </h3>
        )}
        <ul className="flex flex-wrap gap-x-3 text-sm">
          {period.filings.map((f) => (
            <li key={f.accession}>
              <a
                className={`inline-flex min-h-10 items-center ${linkStyle}`}
                href={edgarUrl(cik, f)}
                target="_blank"
                rel="noopener noreferrer"
              >
                {f.form} filed {f.filed} ↗
              </a>
            </li>
          ))}
        </ul>
      </div>
      {period.note && (
        <p className="text-sm text-muted-foreground">{period.note}</p>
      )}
      {period.snapshot && (
        <Positions snapshot={period.snapshot} previous={previous} />
      )}
    </div>
  );
}

export function SecPositions({
  cik,
  data,
}: {
  cik: string;
  data: SecHoldings;
}) {
  const [latest, prior] = data.periods;
  const previous =
    latest?.snapshot &&
    prior?.snapshot &&
    adjacentQuarters(
      prior.snapshot.filing.period,
      latest.snapshot.filing.period,
    )
      ? prior.snapshot
      : undefined;
  return (
    <section
      className="min-w-0 space-y-3 sm:space-y-5"
      aria-labelledby="quarterly-holdings"
    >
      <h2
        id="quarterly-holdings"
        tabIndex={-1}
        className={`scroll-mt-32 ${sectionTitle}`}
      >
        Quarterly holdings
      </h2>
      {latest?.snapshot && (
        <p className="!mt-1 text-sm text-muted-foreground">
          Reported by {latest.snapshot.manager}.
        </p>
      )}
      {data.archived && (
        <p role="status" className="text-sm text-muted-foreground">
          The SEC index is unavailable. Showing saved filings with their
          original reporting dates.
        </p>
      )}
      {latest ? (
        <Period cik={cik} period={latest} previous={previous} showQuarter />
      ) : (
        <p>No recent 13F report was available for this manager.</p>
      )}
      {prior && (
        <details className="border-y py-3">
          <summary className="cursor-pointer text-sm font-medium">
            Previous report · {prior.filings[0]!.period}
          </summary>
          <div className="pt-4">
            <Period cik={cik} period={prior} />
          </div>
        </details>
      )}
      <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">
        Form 13F shows securities the firm reported at quarter end. Short
        positions are excluded. For options, the figures describe the underlying
        securities. A difference between filings gives no execution date or
        trade price.{" "}
        <a
          className={linkStyle}
          href="https://www.sec.gov/rules-regulations/staff-guidance/frequently-asked-questions-about-form-13f"
        >
          SEC guide to Form 13F
        </a>
      </p>
    </section>
  );
}
