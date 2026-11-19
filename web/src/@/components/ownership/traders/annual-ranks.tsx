import Link from "next/link";
import {
  investorHref,
  investorPct,
  type RANKED_HOLDERS,
} from "~/@/lib/ownership/australian-investors";
import { registerHref } from "~/@/lib/ownership/kinds";

type AnnualRow = (typeof RANKED_HOLDERS)[number];
const printedRanks = Array.from({ length: 20 }, (_, i) => i + 1);
const rankList = new Intl.ListFormat("en-AU", { type: "conjunction" });
const rankAnchor = (r: AnnualRow) =>
  `rank-${r.code.toLowerCase()}-${r.date}-${r.rank}`;

export function AnnualRankSummary({ rows }: { rows: AnnualRow[] }) {
  const reports = new Map<string, AnnualRow[]>();
  for (const row of rows) {
    const key = `${row.code}-${row.date}`;
    const entries = reports.get(key);
    if (entries) entries.push(row);
    else reports.set(key, [row]);
  }
  return (
    <div className="space-y-2">
      {Array.from(reports, ([key, entries]) => {
        const ranks = entries.map((r) => r.rank).sort((a, b) => a - b);
        return (
          <div
            key={key}
            className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-l-2 border-primary pl-3"
          >
            <div className="min-w-0">
              <p className="text-sm font-medium">{entries[0]!.company}</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {ranks.length === 1 ? "Rank" : "Ranks"}{" "}
                {rankList.format(ranks.map(String))} of 20{" "}
                {entries[0]!.dateBasis
                  ? "entries in the report"
                  : "registered accounts"}
              </p>
            </div>
            <div
              aria-hidden="true"
              className="grid w-36 max-w-full grid-cols-[repeat(20,minmax(0,1fr))] items-end gap-[2px]"
            >
              {printedRanks.map((rank) => (
                <span
                  key={rank}
                  className={
                    ranks.includes(rank)
                      ? "h-4 rounded-sm bg-primary"
                      : "h-2 rounded-sm bg-muted-foreground/30"
                  }
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

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
            Date / source
          </th>
        </tr>
      </thead>
      <tbody className="divide-y border-b max-md:block max-md:border-t">
        {rows.map((row) => (
          <tr
            role="row"
            id={linkProfiles ? undefined : rankAnchor(row)}
            tabIndex={linkProfiles ? undefined : -1}
            key={`${row.code}-${row.date}-${row.rank}`}
            className="scroll-mt-32 target:bg-muted/60 max-md:grid max-md:grid-cols-[minmax(0,1fr)_auto] max-md:items-start max-md:gap-x-3 max-md:gap-y-2 max-md:py-3"
          >
            <td className="whitespace-nowrap max-md:col-start-2 max-md:row-start-1 max-md:text-right md:py-3 md:pr-3">
              <Link
                prefetch={false}
                href={registerHref(row.code)}
                className="text-primary underline underline-offset-4 hover:decoration-2"
              >
                {row.code}
              </Link>{" "}
              ·{" "}
              <a
                href={`${linkProfiles ? investorHref(row.profile) : ""}#${rankAnchor(row)}`}
                aria-label={`Rank ${row.rank} · ${row.code} ${row.dateBasis ? "financial year ended" : "register dated"} ${row.date}`}
                className="inline-flex min-h-6 items-center text-primary underline underline-offset-4 hover:decoration-2"
              >
                #{row.rank}
              </a>
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
                {row.dateBasis && "FY ended "}
                {row.date}
              </time>{" "}
              <span aria-hidden="true" className="md:hidden">
                ·{" "}
              </span>
              <a
                href={row.source}
                aria-label={`Annual report · p. ${row.page}, ${row.code} ${row.dateBasis ? "financial year ended" : "shareholder register dated"} ${row.date}`}
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
