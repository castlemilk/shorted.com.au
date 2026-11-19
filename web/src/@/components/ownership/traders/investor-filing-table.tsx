import Link from "next/link";
import {
  investorBySlug,
  investorHref,
  investorPct,
} from "~/@/lib/ownership/australian-investors";
import { filingId } from "~/@/lib/ownership/investor-activity";
import type { DisclosureRow } from "~/@/lib/ownership/investor-disclosures";
import { registerHref } from "~/@/lib/ownership/kinds";
import { filerHref } from "~/@/lib/ownership/named-filer";
import { MovementLabel } from "./filing-movement";
import { FollowInvestor } from "./investor-follow";

const link = "text-primary underline-offset-4 hover:underline";
type ReadState = {
  ids: ReadonlySet<string>;
  mark: (ids: string[], read: boolean) => void;
};

export function InvestorFilingTable({
  rows,
  readState,
}: {
  rows: DisclosureRow[];
  readState?: ReadState;
}) {
  return (
    <div className="min-w-0">
      <table role="table" className="w-full text-left text-sm max-md:block">
        <caption className="sr-only">
          {readState
            ? "Filings from followed investors and filers"
            : "Latest releases by issuer and filed name"}
        </caption>
        <thead className="border-y bg-muted/40 text-xs text-muted-foreground max-md:sr-only">
          <tr>
            <th scope="col" className="p-2">
              Filed name / issuer
            </th>
            <th scope="col" className="p-2 text-right">
              Voting power
            </th>
            <th scope="col" className="p-2 text-right">
              Change
            </th>
            <th scope="col" className="p-2">
              Release / source
            </th>
            <th scope="col" className="p-2 text-right">
              {readState ? "Review" : "Track"}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y max-md:block max-md:border-y">
          {rows.map((row) => {
            const id = filingId(row);
            const person = row.profile
              ? investorBySlug(row.profile)
              : undefined;
            const seen = readState?.ids.has(id) ?? false;
            return (
              <tr
                key={id}
                role="row"
                className="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-start max-md:gap-x-3 max-md:gap-y-2 max-md:py-3.5"
              >
                <th
                  scope="row"
                  role="rowheader"
                  className="max-w-lg align-top font-normal max-md:col-start-1 max-md:row-start-1 md:p-2"
                >
                  <Link
                    href={
                      person
                        ? investorHref(person.slug)
                        : filerHref(row.code, row.name)
                    }
                    prefetch={false}
                    className="break-words font-medium underline-offset-4 hover:text-primary hover:underline"
                  >
                    {row.name}
                  </Link>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    <Link
                      prefetch={false}
                      className={link}
                      href={registerHref(row.code)}
                    >
                      {row.code}
                    </Link>
                    {row.company && ` · ${row.company}`}
                  </span>
                </th>
                <td className="align-top tabular-nums max-md:col-start-1 max-md:row-start-2 md:p-2 md:text-right">
                  <span
                    aria-hidden="true"
                    className="block text-xs text-muted-foreground md:hidden"
                  >
                    Voting power
                  </span>
                  <span>
                    {row.ceased
                      ? "Ceased"
                      : row.pct === null
                        ? "Unstated"
                        : investorPct(row.pct)}
                  </span>
                </td>
                <td className="align-top max-md:col-start-2 max-md:row-start-2 max-md:text-right md:p-2 md:text-right">
                  <span
                    aria-hidden="true"
                    className="block text-xs text-muted-foreground md:hidden"
                  >
                    Change
                  </span>
                  <MovementLabel row={row} />
                </td>
                <td className="whitespace-nowrap align-top md:p-2 max-md:col-span-2 max-md:row-start-3">
                  <time
                    className="text-xs text-muted-foreground md:text-sm"
                    dateTime={row.date}
                  >
                    {row.date}
                  </time>{" "}
                  {row.source && (
                    <a
                      href={row.source}
                      className={`text-xs md:mt-1 md:block ${link}`}
                    >
                      Form {row.form}
                    </a>
                  )}
                </td>
                <td className="text-right align-top max-md:col-start-2 max-md:row-start-1 md:p-2">
                  {readState ? (
                    <button
                      type="button"
                      aria-pressed={seen}
                      aria-label={`Read filing from ${row.name} at ${row.code} on ${row.date}`}
                      onClick={() => readState.mark([id], !seen)}
                      className="inline-flex min-h-9 items-center gap-1.5 rounded px-2 text-xs font-medium underline-offset-4 hover:bg-muted hover:underline aria-pressed:text-muted-foreground"
                    >
                      {!seen && (
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-primary"
                        />
                      )}
                      {seen ? "Read" : "Unread"}
                    </button>
                  ) : person ? (
                    <FollowInvestor slug={person.slug} name={person.name} />
                  ) : (
                    <FollowInvestor
                      code={row.code}
                      name={row.name}
                      source={row.source ?? undefined}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
