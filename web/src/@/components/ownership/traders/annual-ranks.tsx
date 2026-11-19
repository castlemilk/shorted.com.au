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
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <caption className="sr-only">
          Registered accounts in annual top-20 shareholder lists
        </caption>
        <thead className="border-y text-xs text-muted-foreground">
          <tr>
            <th scope="col" className="p-2">
              Issuer / rank
            </th>
            <th scope="col" className="p-2">
              Registered shareholder
            </th>
            <th scope="col" className="p-2 text-right">
              Ordinary shares
            </th>
            <th scope="col" className="p-2 text-right">
              Issued shares
            </th>
            <th scope="col" className="p-2">
              Register date / source
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={`${row.code}-${row.date}-${row.rank}`}>
              <td className="whitespace-nowrap p-2">
                <Link
                  prefetch={false}
                  href={registerHref(row.code)}
                  className="text-primary hover:underline"
                >
                  {row.code}
                </Link>{" "}
                · #{row.rank}
              </td>
              <th scope="row" className="p-2 font-medium">
                {linkProfiles ? (
                  <Link
                    prefetch={false}
                    href={investorHref(row.profile)}
                    className="text-primary hover:underline"
                  >
                    {row.name}
                  </Link>
                ) : (
                  row.name
                )}
              </th>
              <td className="p-2 text-right tabular-nums">
                {row.shares.toLocaleString("en-AU")}
              </td>
              <td className="p-2 text-right tabular-nums">
                {investorPct(row.pct)}
              </td>
              <td className="whitespace-nowrap p-2">
                <time dateTime={row.date}>{row.date}</time>
                <a
                  href={row.source}
                  className="block text-xs text-primary hover:underline"
                >
                  Annual report · p. {row.page}
                </a>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
