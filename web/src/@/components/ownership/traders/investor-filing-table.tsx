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
      <table role="table" className="w-full text-left text-sm max-sm:block">
        <caption className="sr-only">
          {readState
            ? "Filings from followed investors and filers"
            : "Latest releases by issuer and filed name"}
        </caption>
        <thead className="border-y text-xs text-muted-foreground max-sm:sr-only">
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
            {readState && (
              <th scope="col" className="p-2">
                Review
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y max-sm:block max-sm:border-y">
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
                className="max-sm:grid max-sm:grid-cols-2 max-sm:gap-2 max-sm:py-3"
              >
                <th
                  scope="row"
                  role="rowheader"
                  className="max-w-lg align-top font-normal max-sm:col-span-2 sm:p-2"
                >
                  <Link
                    href={
                      person
                        ? investorHref(person.slug)
                        : filerHref(row.code, row.name)
                    }
                    prefetch={false}
                    className={`break-words font-medium ${link}`}
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
                  {!readState && (
                    <span className="mt-2 block">
                      {person ? (
                        <FollowInvestor slug={person.slug} name={person.name} />
                      ) : (
                        <FollowInvestor
                          code={row.code}
                          name={row.name}
                          source={row.source ?? undefined}
                        />
                      )}
                    </span>
                  )}
                </th>
                <td className="align-top tabular-nums sm:p-2 sm:text-right">
                  <span
                    aria-hidden="true"
                    className="block text-xs text-muted-foreground sm:hidden"
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
                <td className="align-top sm:p-2 sm:text-right">
                  <span
                    aria-hidden="true"
                    className="block text-xs text-muted-foreground sm:hidden"
                  >
                    Change
                  </span>
                  <MovementLabel row={row} />
                </td>
                <td className="whitespace-nowrap align-top sm:p-2">
                  <time dateTime={row.date}>{row.date}</time>
                  {row.source && (
                    <a href={row.source} className={`block text-xs ${link}`}>
                      Form {row.form}
                    </a>
                  )}
                </td>
                {readState && (
                  <td className="align-top sm:p-2">
                    <button
                      type="button"
                      aria-pressed={seen}
                      aria-label={`Read filing from ${row.name} at ${row.code} on ${row.date}`}
                      onClick={() => readState.mark([id], !seen)}
                      className="inline-flex items-center gap-1.5 rounded border px-2 py-1 text-xs hover:bg-muted aria-pressed:text-muted-foreground"
                    >
                      {!seen && (
                        <span
                          aria-hidden="true"
                          className="size-1.5 rounded-full bg-primary"
                        />
                      )}
                      {seen ? "Read" : "Unread"}
                    </button>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
