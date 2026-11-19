import Link from "next/link";
import {
  investorHref,
  investorPct,
  type RANKED_HOLDERS,
} from "~/@/lib/ownership/australian-investors";
import { registerHref } from "~/@/lib/ownership/kinds";

export function AnnualRanks({
  rows,
  linkProfiles = false,
}: {
  rows: typeof RANKED_HOLDERS;
  linkProfiles?: boolean;
}) {
  return (
    <table role="table" className="w-full text-left text-sm max-md:block">
      <caption className="sr-only">
        Registered accounts in annual top-20 shareholder lists
      </caption>
      <thead className="border-y bg-muted/40 text-xs text-muted-foreground max-md:sr-only">
        <tr>
          <th scope="col" className="py-2 pr-3 font-medium">
            Issuer / rank
          </th>
          <th scope="col" className="p-2 font-medium">
            Registered shareholder
          </th>
          <th scope="col" className="p-2 text-right font-medium">
            Ordinary shares
          </th>
          <th scope="col" className="p-2 text-right font-medium">
            Share of issuer
          </th>
          <th scope="col" className="py-2 pl-4 font-medium">
            Register date / source
          </th>
        </tr>
      </thead>
      <tbody className="divide-y border-b max-md:block max-md:border-t">
        {rows.map((row) => (
          <tr
            role="row"
            key={`${row.code}-${row.date}-${row.rank}`}
            className="max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-start max-md:gap-x-3 max-md:gap-y-2 max-md:py-3"
          >
            <td className="whitespace-nowrap max-md:col-start-2 max-md:row-start-1 max-md:text-right md:py-3 md:pr-3">
              <Link
                prefetch={false}
                href={registerHref(row.code)}
                className="text-primary underline underline-offset-4 hover:decoration-2"
              >
                {row.code}
              </Link>{" "}
              · #{row.rank}
            </td>
            <th
              role="rowheader"
              scope="row"
              className="min-w-0 break-words font-medium max-md:col-start-1 max-md:row-start-1 md:p-2"
            >
              {linkProfiles ? (
                <Link
                  prefetch={false}
                  href={investorHref(row.profile)}
                  className="underline-offset-4 hover:text-primary hover:underline"
                >
                  {row.name}
                </Link>
              ) : (
                row.name
              )}
            </th>
            <td className="tabular-nums max-md:col-start-1 max-md:row-start-2 md:p-2 md:text-right">
              <span
                aria-hidden="true"
                className="block text-xs text-muted-foreground md:hidden"
              >
                Ordinary shares
              </span>
              <span>{row.shares.toLocaleString("en-AU")}</span>
            </td>
            <td className="text-right tabular-nums max-md:col-start-2 max-md:row-start-2 md:w-32 md:p-2">
              <span
                aria-hidden="true"
                className="block text-xs text-muted-foreground md:hidden"
              >
                Share of issuer
              </span>
              <span className="font-semibold">{investorPct(row.pct)}</span>
              <span
                aria-hidden="true"
                className="ml-auto mt-1 block h-[3px] w-20 bg-border md:w-24"
              >
                <span
                  className="block h-full bg-primary"
                  style={{ width: `${row.pct}%` }}
                />
              </span>
            </td>
            <td className="text-xs max-md:col-span-2 max-md:row-start-3 md:pl-4">
              <time className="text-muted-foreground" dateTime={row.date}>
                {row.date}
              </time>{" "}
              <span aria-hidden="true" className="md:hidden">
                ·{" "}
              </span>
              <a
                href={row.source}
                aria-label={`Annual report · p. ${row.page}, ${row.code} shareholder register dated ${row.date}`}
                className="inline-flex min-h-10 items-center text-primary underline underline-offset-4 hover:decoration-2 md:flex"
              >
                Annual report · p. {row.page}
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
