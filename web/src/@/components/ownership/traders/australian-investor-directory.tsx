"use client";

import Link from "next/link";
import { useState } from "react";
import {
  AUSTRALIAN_INVESTORS,
  filedNameKey,
  investorCodes,
  investorHref,
  investorPct,
  ranksForInvestor,
  RANKED_HOLDERS,
  REGISTER_SNAPSHOTS,
} from "~/@/lib/ownership/australian-investors";
import {
  DISCOVERY_WINDOW,
  type Discovery,
} from "~/@/lib/ownership/investor-disclosures";
import { filerHref } from "~/@/lib/ownership/named-filer";
import { registerHref } from "~/@/lib/ownership/kinds";
import { sectionTitle } from "~/@/lib/typography";
import { AnnualRanks } from "./annual-ranks";
import { FollowInvestor, useFollowedInvestors } from "./investor-follow";

const sections = ["Investors", "Recent filings", "Annual ranks"] as const;
const profiles = AUSTRALIAN_INVESTORS.map((person) => {
  const codes = investorCodes(person);
  const ranks = ranksForInvestor(person.slug);
  const search = filedNameKey(
    [
      person.name,
      ...codes,
      ...person.filings.map((f) => f.filedName),
      ...ranks.flatMap((r) => [r.name, r.company]),
    ].join(" "),
  );
  return { person, codes, search };
});
const ranked = [...RANKED_HOLDERS].sort(
  (a, b) => a.rank - b.rank || a.code.localeCompare(b.code),
);
const control = "h-10 rounded-md border bg-background px-3 text-sm";
const link = "text-primary underline-offset-4 hover:underline";
const chunk = 25;

export function AustralianInvestorDirectory({ feed }: { feed: Discovery }) {
  const [section, setSection] =
    useState<(typeof sections)[number]>("Investors");
  const [query, setQuery] = useState("");
  const [onlyFollowed, setOnlyFollowed] = useState(false);
  const [titled, setTitled] = useState(false);
  const [largest, setLargest] = useState(false);
  const [limit, setLimit] = useState(chunk);
  const followed = useFollowedInvestors();
  const q = filedNameKey(query);
  const investors = profiles.filter(
    ({ person, search }) =>
      search.includes(q) &&
      (!onlyFollowed || followed.some((p) => p.id === person.slug)),
  );
  const savedFilers = onlyFollowed
    ? followed.filter(
        (p) => p.code && filedNameKey(`${p.name} ${p.code}`).includes(q),
      )
    : [];
  const filings = feed.rows.filter(
    (r) =>
      (!titled || /^(?:mr|mrs|ms|miss|dr)\.?\s/i.test(r.name.trim())) &&
      filedNameKey(`${r.name} ${r.code} ${r.company}`).includes(q),
  );
  if (largest) filings.sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));
  const ranks = ranked.filter((r) =>
    filedNameKey(
      `${r.name} ${r.code} ${r.company} ${AUSTRALIAN_INVESTORS.find((p) => p.slug === r.profile)?.name ?? ""}`,
    ).includes(q),
  );

  return (
    <div className="min-w-0 space-y-5">
      <div
        role="group"
        aria-label="Investor discovery views"
        className="flex flex-wrap gap-1 border-b"
      >
        {sections.map((s) => (
          <button
            type="button"
            key={s}
            aria-pressed={section === s}
            onClick={() => {
              setSection(s);
              setLimit(chunk);
            }}
            className="border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground aria-pressed:border-primary aria-pressed:font-semibold aria-pressed:text-foreground"
          >
            {s}
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="grid min-w-0 flex-1 gap-1 text-xs">
          Search names or ASX codes
          <input
            type="search"
            value={query}
            placeholder="e.g. Maas, RealWise or HVN"
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(chunk);
            }}
            className={control}
          />
        </label>
        {section === "Investors" && (
          <button
            type="button"
            aria-pressed={onlyFollowed}
            onClick={() => setOnlyFollowed(!onlyFollowed)}
            className={`${control} aria-pressed:border-primary aria-pressed:text-primary`}
          >
            Following ({followed.length})
          </button>
        )}
        {section === "Recent filings" && (
          <label className="flex h-10 items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={titled}
              onChange={(e) => {
                setTitled(e.target.checked);
                setLimit(chunk);
              }}
            />
            Starts with a personal title
          </label>
        )}
        {section === "Recent filings" && (
          <label className="grid gap-1 text-xs">
            Order by
            <select
              className={control}
              value={largest ? "largest" : "latest"}
              onChange={(e) => {
                setLargest(e.target.value === "largest");
                setLimit(chunk);
              }}
            >
              <option value="latest">Latest release</option>
              <option value="largest">Largest reported voting power</option>
            </select>
          </label>
        )}
      </div>
      {section === "Investors" && (
        <section aria-label="Investor profiles" className="space-y-3">
          <h2 className={sectionTitle}>People named in disclosures</h2>
          <p className="text-sm text-muted-foreground">
            {investors.length + savedFilers.length} matches. Follow a profile to
            save it in this browser.
          </p>
          <ul className="divide-y border-y">
            {investors.map(({ person, codes }) => (
              <li
                key={person.slug}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <Link
                    href={investorHref(person.slug)}
                    prefetch={false}
                    className={`font-medium ${link}`}
                  >
                    {person.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {codes.join(" · ")} ·{" "}
                    {person.filings.some((f) => !f.basis)
                      ? "Substantial holding notices"
                      : "Annual shareholder register"}
                  </p>
                </div>
                <FollowInvestor slug={person.slug} name={person.name} />
              </li>
            ))}
            {savedFilers.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-4 py-3"
              >
                <div className="min-w-0">
                  <Link
                    prefetch={false}
                    className={link}
                    href={filerHref(p.code!, p.name)}
                  >
                    {p.name}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {p.code} · Filed name{" "}
                    {p.source && (
                      <>
                        {" "}
                        ·{" "}
                        <a href={p.source} className={link}>
                          Saved filing
                        </a>
                      </>
                    )}
                  </p>
                </div>
                <FollowInvestor code={p.code!} name={p.name} />
              </li>
            ))}
          </ul>
          {!investors.length && !savedFilers.length && (
            <p>
              {onlyFollowed
                ? "No followed profiles match. Select Following again to see all investors."
                : "No investor profiles match. Search Recent filings for other names."}
            </p>
          )}
        </section>
      )}
      {section === "Recent filings" && (
        <section
          aria-label="Recent substantial holding filings"
          className="space-y-3"
        >
          <h2 className={sectionTitle}>Recent substantial holding filings</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Explore Forms 603, 604 and 605 released in the last{" "}
            {DISCOVERY_WINDOW} days by filers outside Shorted’s institution
            directory. Each row shows the latest of these forms for an issuer
            and filed name. Filers include people, companies and trustees.
          </p>
          {feed.status === "unavailable" ? (
            <p role="status">The filings feed is temporarily unavailable.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {feed.status === "partial" ? "Partial coverage. " : ""}
                {feed.read} of {feed.total} notices read · Data through{" "}
                {feed.asOf} · {filings.length} matching issuer and name pairs
              </p>
              {filings.length ? (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm">
                    <caption className="sr-only">
                      Latest releases by issuer and filed name
                    </caption>
                    <thead className="border-y text-xs text-muted-foreground">
                      <tr>
                        <th scope="col" className="p-2">
                          Filed name
                        </th>
                        <th scope="col" className="p-2">
                          Issuer
                        </th>
                        <th scope="col" className="p-2 text-right">
                          Voting power
                        </th>
                        <th scope="col" className="p-2">
                          Release / source
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {filings.slice(0, limit).map((row) => (
                        <tr key={`${row.code}/${row.name}`}>
                          <th scope="row" className="max-w-md p-2 font-medium">
                            <Link
                              href={
                                row.profile
                                  ? investorHref(row.profile)
                                  : filerHref(row.code, row.name)
                              }
                              prefetch={false}
                              className={link}
                            >
                              {row.name}
                            </Link>
                            <div className="mt-1">
                              {row.profile ? null : (
                                <FollowInvestor
                                  code={row.code}
                                  name={row.name}
                                  source={row.source ?? undefined}
                                />
                              )}
                            </div>
                          </th>
                          <td className="p-2">
                            <Link
                              href={registerHref(row.code)}
                              prefetch={false}
                              className={link}
                            >
                              {row.code}
                            </Link>
                          </td>
                          <td className="p-2 text-right tabular-nums">
                            {row.ceased
                              ? "Ceased"
                              : row.pct === null
                                ? "Unstated"
                                : investorPct(row.pct)}
                          </td>
                          <td className="whitespace-nowrap p-2">
                            <time dateTime={row.date}>{row.date}</time>
                            {row.source && (
                              <a
                                href={row.source}
                                className={`block text-xs ${link}`}
                              >
                                Form {row.form}
                              </a>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>No filings match this search.</p>
              )}
              {limit < filings.length && (
                <button
                  type="button"
                  className={control}
                  onClick={() => setLimit(limit + chunk)}
                >
                  Show more filings
                </button>
              )}
            </>
          )}
        </section>
      )}
      {section === "Annual ranks" && (
        <section
          aria-label="Annual shareholder ranks"
          className="min-w-0 space-y-3"
        >
          <h2 className={sectionTitle}>Annual shareholder ranks</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Selected named accounts from {REGISTER_SNAPSHOTS.length} issuers’
            top-20 registers. Rank is within each issuer on the date shown. The
            same shareholder can hold several separately ranked accounts.
          </p>
          {ranks.length ? (
            <AnnualRanks rows={ranks} linkProfiles />
          ) : (
            <p>No registered names match this search.</p>
          )}
        </section>
      )}
    </div>
  );
}
