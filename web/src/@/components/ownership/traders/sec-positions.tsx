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
  return (
    <>
      <dl className="flex flex-wrap gap-x-10 gap-y-3 border-y py-3">
        <div>
          <dt className="text-xs text-muted-foreground">Entries filed</dt>
          <dd className="mt-1 font-medium tabular-nums">
            {snapshot.positions.length}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-muted-foreground">
            Value on filing cover
          </dt>
          <dd className="mt-1 font-medium tabular-nums [overflow-wrap:anywhere]">
            US$
            <wbr />
            {number.format(snapshot.totalUsd)}
          </dd>
        </div>
      </dl>
      {sum !== snapshot.totalUsd && (
        <details className="text-sm text-muted-foreground">
          <summary className="min-h-10 cursor-pointer py-2.5">
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
        <p className="text-xs text-muted-foreground">
          Quantity change since{" "}
          <time dateTime={previous.filing.period}>
            {previous.filing.period}
          </time>
          .
        </p>
      )}
      <PositionsTable
        rows={currentRows}
        caption={`${snapshot.manager} positions reported for ${snapshot.filing.period}`}
        showChange={!!previous}
      />
      {previous && priorOnly.length > 0 && (
        <details className="border-t">
          <summary className="min-h-10 cursor-pointer py-3 text-sm font-medium">
            Only in the previous filing ({priorOnly.length})
          </summary>
          <p className="pb-2 text-xs text-muted-foreground">
            Quantities and values reported on{" "}
            <time dateTime={previous.filing.period}>
              {previous.filing.period}
            </time>
            .
          </p>
          <PositionsTable
            rows={priorOnly}
            caption={`Positions reported only in the previous filing, ${previous.filing.period}`}
          />
        </details>
      )}
    </>
  );
}

function Period({
  cik,
  period,
  previous,
}: {
  cik: string;
  period: FilingPeriod;
  previous?: Snapshot;
}) {
  return (
    <div className="space-y-3">
      <ul className="flex flex-wrap gap-3 text-sm">
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
      <h2 id="quarterly-holdings" className={sectionTitle}>
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
        <>
          <h3 className="font-semibold">
            Quarter ended {latest.filings[0]!.period}
          </h3>
          <Period cik={cik} period={latest} previous={previous} />
        </>
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
