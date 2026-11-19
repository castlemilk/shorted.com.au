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
import { edgarUrl, type Snapshot } from "~/server/traders/sec-filings";
import type {
  FilingPeriod,
  SecHoldings,
} from "~/server/traders/get-sec-holdings";

const number = new Intl.NumberFormat("en-AU");
const signed = new Intl.NumberFormat("en-AU", { signDisplay: "exceptZero" });
const linkStyle =
  "text-primary underline decoration-primary/40 underline-offset-4 hover:decoration-primary";

function Positions({
  snapshot,
  previous,
}: {
  snapshot: Snapshot;
  previous?: Snapshot;
}) {
  const rows = comparePositions(snapshot, previous);
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
        <div>
          <dt className="text-xs text-muted-foreground">
            Value on filing cover
          </dt>
          <dd className="mt-1 font-medium tabular-nums">
            US${number.format(snapshot.totalUsd)}
          </dd>
        </div>
      </dl>
      {sum !== snapshot.totalUsd && (
        <p className="border-l-2 border-primary/50 pl-3 text-sm text-muted-foreground">
          The position rows total US${number.format(sum)}, a difference of US$
          {number.format(Math.abs(sum - snapshot.totalUsd))} from the cover.
        </p>
      )}
      {snapshot.confidentialOmitted && (
        <p className="text-sm text-muted-foreground">
          The manager marked holdings as confidentially omitted.
        </p>
      )}
      {previous && (
        <p className="text-xs text-muted-foreground">
          Quantity changes compare the holdings reported on{" "}
          {previous.filing.period} and {snapshot.filing.period}.
        </p>
      )}
      <Table>
        <caption className="sr-only">
          {snapshot.manager} positions reported for {snapshot.filing.period}
        </caption>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Security</TableHead>
            <TableHead scope="col" className="text-right">
              Quantity
            </TableHead>
            {previous && (
              <TableHead scope="col" className="text-right">
                Change in quantity
              </TableHead>
            )}
            <TableHead scope="col" className="text-right">
              Value (US$)
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ current, previous: before }) => {
            const position = (current ?? before)!;
            const units =
              position.unit === "PRN"
                ? "principal"
                : position.option
                  ? "underlying shares"
                  : "shares";
            const change = !current
              ? "Prior filing only"
              : !before
                ? "This filing only"
                : signed.format(current.quantity - before.quantity);
            return (
              <TableRow
                key={`${position.cusip}:${position.unit}:${position.option}`}
              >
                <TableCell>
                  <span className="block font-medium">{position.issuer}</span>
                  <span className="text-xs text-muted-foreground">
                    {position.securityClass}
                    {position.option &&
                      ` · ${position.option.toLowerCase()} option`}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {current ? number.format(current.quantity) : "n/a"}
                  {current && (
                    <span className="block text-xs text-muted-foreground">
                      {units}
                    </span>
                  )}
                </TableCell>
                {previous && (
                  <TableCell className="text-right text-xs tabular-nums">
                    {change}
                  </TableCell>
                )}
                <TableCell className="text-right tabular-nums">
                  {current ? number.format(current.usd) : "n/a"}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
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
              className={linkStyle}
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
    <section className="min-w-0 space-y-5" aria-labelledby="quarterly-holdings">
      <h2 id="quarterly-holdings" className={sectionTitle}>
        Quarterly holdings
      </h2>
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
