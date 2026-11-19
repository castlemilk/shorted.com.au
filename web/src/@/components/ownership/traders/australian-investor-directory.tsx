"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
import { useId, useState, type ReactNode } from "react";
import { Search, SlidersHorizontal } from "lucide-react";
import {
  AUSTRALIAN_INVESTORS,
  filedNameKey,
  investorBySlug,
  investorCodes,
  investorHref,
  investorPct,
  ranksForInvestor,
  RANKED_HOLDERS,
  REGISTER_SNAPSHOTS,
  TRACKED_ISSUERS,
} from "~/@/lib/ownership/australian-investors";
import {
  filingEvents,
  matchesWords,
  PAGE_SIZE,
  selectFilings,
  type FilingEvent,
  type FilingOrder,
} from "~/@/lib/ownership/investor-activity";
import {
  archivedDisclosure,
  DISCOVERY_WINDOW,
  type Discovery,
  type DisclosureRow,
} from "~/@/lib/ownership/investor-disclosures";
import { noticeEventLabel } from "~/@/lib/ownership/events";
import { formatIsoDate } from "~/@/lib/strategies/format";
import { sectionTitle } from "~/@/lib/typography";
import { InvestorThumbnail } from "./investor-thumbnail";
import { GRAPH_PATH, graphHref } from "~/@/lib/ownership/graph-links";
import { Network } from "lucide-react";
import { AnnualRanks } from "./annual-ranks";
import { FollowInvestor, useFollowedInvestors } from "./investor-follow";
import { InvestorFilingTable } from "./investor-filing-table";
import {
  defaultView,
  updateTrackerQuery,
  useTrackerQuery,
  type TrackerView,
} from "./tracker-query";

const InvestorWatchlist = dynamic(
  () =>
    import("./investor-watchlist").then((module) => module.InvestorWatchlist),
  {
    loading: () => (
      <p role="status" className="text-sm">
        Loading followed filings…
      </p>
    ),
  },
);

const views: { value: TrackerView; label: string }[] = [
  { value: "investors", label: "Investors" },
  { value: "filings", label: "Recent filings" },
  { value: "ranks", label: "Annual ranks" },
  { value: "following", label: "Following" },
];
type DirectoryEntry = {
  code: string;
  date: string;
  name: string;
  source: string | null;
  document: string;
  interest: string;
  basis: "notice" | "substantial" | "rank";
  rank?: number;
  extraAccounts?: number;
  yearEnd?: boolean;
};

function noticeEntry(row: DisclosureRow): DirectoryEntry {
  return {
    code: row.code,
    date: row.date,
    name: row.name,
    source: row.source,
    document: `Form ${row.form}`,
    basis: "notice",
    interest: row.ceased
      ? "Ceased to be substantial"
      : row.pct === null
        ? "Voting power unstated"
        : `${investorPct(row.pct)}\nvoting power`,
  };
}

const entryOrder = { notice: 0, substantial: 1, rank: 2 };
function newestFirst(a: DirectoryEntry, b: DirectoryEntry) {
  return (
    b.date.localeCompare(a.date) ||
    entryOrder[a.basis] - entryOrder[b.basis] ||
    (a.rank ?? 0) - (b.rank ?? 0)
  );
}

const companyNames = new Map<string, string>();
const profiles = AUSTRALIAN_INVESTORS.map((person) => {
  const codes = investorCodes(person);
  const ranks = ranksForInvestor(person.slug);
  const entries: DirectoryEntry[] = ranks.map((r) => {
    companyNames.set(r.code, r.company);
    return {
      code: r.code,
      date: r.date,
      name: r.name,
      source: r.source,
      document: "Annual register",
      basis: "rank",
      rank: r.rank,
      extraAccounts: ranks.filter(
        (other) =>
          other.code === r.code &&
          other.date === r.date &&
          other.rank !== r.rank,
      ).length,
      interest: `#${r.rank} · ${investorPct(r.pct)}\nof issued shares`,
      yearEnd: !!r.dateBasis,
    };
  });
  for (const filing of person.filings) {
    const archived = archivedDisclosure(filing);
    if (archived) {
      companyNames.set(filing.code, archived.company);
      entries.push(noticeEntry(archived));
    }
    const interest = filing.annualInterest;
    if (interest) {
      companyNames.set(filing.code, interest.company);
      const amount = interest.amount;
      entries.push({
        code: filing.code,
        date: interest.date,
        name: filing.filedName,
        source: filing.source,
        document: "Annual report",
        basis: "substantial",
        interest:
          amount.pct !== undefined
            ? `${investorPct(amount.pct)}\nreported interest`
            : `${amount.shares!.toLocaleString("en-AU")}\nshares reported`,
      });
    }
  }
  const search = [
    person.name,
    person.alternateName,
    ...(person.jointNames ?? []),
    ...codes,
    ...person.filings.flatMap((f) => [f.filedName, ...(f.aliases ?? [])]),
    ...ranks.map((r) => r.name),
  ].join(" ");
  return { person, codes, entries, search };
});
const ranksByIssuer = [...RANKED_HOLDERS].sort(
  (a, b) => a.rank - b.rank || a.code.localeCompare(b.code),
);
const ranksByStake = [...ranksByIssuer].sort((a, b) => b.pct - a.pct);
const control = "h-10 max-w-full rounded-md border bg-background px-3 text-sm";
const link = "text-primary underline-offset-4 hover:underline";

const directoryGrid =
  "grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 md:grid-cols-[minmax(12rem,1.6fr)_minmax(10rem,1fr)_minmax(8rem,0.7fr)_5.5rem]";
function People({
  feed,
  query,
  issuer,
  search,
  clear,
}: {
  feed: Discovery;
  query: string;
  issuer: string;
  search: ReactNode;
  clear: ReactNode;
}) {
  const searchedCode = query.trim().toUpperCase();
  const scopedCode =
    issuer || (TRACKED_ISSUERS.includes(searchedCode) ? searchedCode : "");
  const companies = new Map(companyNames);
  const live = new Map<string, DirectoryEntry[]>();
  for (const row of feed.rows) {
    if (row.profile && (!scopedCode || scopedCode === row.code)) {
      const entries = live.get(row.profile) ?? [];
      entries.push(noticeEntry(row));
      live.set(row.profile, entries);
    }
    if (row.company && !companies.has(row.code))
      companies.set(row.code, row.company);
  }
  const matches = profiles
    .filter(
      (p) =>
        (!scopedCode || p.codes.includes(scopedCode)) &&
        matchesWords(
          [p.search, ...p.codes.map((code) => companies.get(code))].join(" "),
          query,
        ),
    )
    .map((p) => {
      const entries = [
        ...(live.get(p.person.slug) ?? []),
        ...p.entries.filter((e) => !scopedCode || scopedCode === e.code),
      ];
      const entry = entries.sort(newestFirst)[0];
      return { ...p, entry };
    })
    .sort(
      (a, b) =>
        (b.entry?.date ?? "").localeCompare(a.entry?.date ?? "") ||
        (scopedCode && a.entry && b.entry
          ? newestFirst(a.entry, b.entry)
          : 0) ||
        a.person.name.localeCompare(b.person.name, "en-AU"),
    );
  const issuerCount = new Set(matches.flatMap((p) => p.codes)).size;
  const first = matches[0]?.entry;
  const registerDate =
    scopedCode &&
    first?.basis === "rank" &&
    !first.yearEnd &&
    matches.every(
      ({ entry }) => entry?.basis === "rank" && entry.date === first.date,
    )
      ? first.date
      : undefined;
  const profileCount = `${matches.length} investor ${matches.length === 1 ? "profile" : "profiles"}`;
  return (
    <section aria-label="Investor profiles" className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
        <div>
          <h2 className={sectionTitle}>
            {scopedCode
              ? `Investors in ${companies.get(scopedCode) ?? scopedCode}`
              : profileCount}
          </h2>
          {(issuerCount > 0 || scopedCode) && (
            <p className="mt-1 text-pretty text-xs text-muted-foreground">
              {scopedCode
                ? profileCount
                : `${issuerCount} ASX ${issuerCount === 1 ? "issuer" : "issuers"}`}
              {" · "}
              {registerDate ? (
                <>
                  Register at{" "}
                  <time dateTime={registerDate} className="whitespace-nowrap">
                    {formatIsoDate(registerDate)}
                  </time>
                </>
              ) : (
                "Latest disclosure first"
              )}
            </p>
          )}
          <Link
            prefetch={false}
            href={scopedCode ? graphHref("company", scopedCode) : GRAPH_PATH}
            className="mt-1 inline-flex min-h-8 items-center gap-1.5 text-sm text-primary underline underline-offset-4"
          >
            <Network aria-hidden="true" className="size-3.5" />
            {scopedCode
              ? "Explore " + scopedCode + " ownership graph"
              : "Explore ownership graph"}
          </Link>
        </div>
        <div className="grid w-full min-w-0 gap-2 sm:w-auto sm:grid-flow-col sm:items-center">
          <div className="min-w-0 sm:w-64">{search}</div>
          <div className="flex min-w-0 items-center gap-3">
            <select
              aria-label="ASX issuer"
              value={issuer}
              className={`${control} min-w-0 flex-1 sm:w-52`}
              onChange={(event) =>
                updateTrackerQuery({ issuer: event.target.value }, true)
              }
            >
              <option value="">All ASX issuers</option>
              {TRACKED_ISSUERS.map((code) => (
                <option key={code} value={code}>
                  {companies.has(code) && companies.get(code) !== code
                    ? `${code} · ${companies.get(code)}`
                    : code}
                </option>
              ))}
            </select>
            {clear}
          </div>
        </div>
      </header>
      {matches.length ? (
        <div>
          <div
            aria-hidden="true"
            className={`${directoryGrid} hidden border-y bg-muted/40 py-2 text-xs text-muted-foreground md:grid`}
          >
            <span>Investor / filed name</span>
            <span className="text-right">Reported interest</span>
            <span>Issuer / source</span>
          </div>
          <ul className="divide-y border-b max-md:border-t">
            {matches.map(({ person, codes, entry }) => {
              const reference = person.filings.find(
                (f) => !scopedCode || f.code === scopedCode,
              );
              const filedName = entry?.name ?? reference?.filedName;
              const code = entry?.code ?? reference?.code;
              const source = entry ? entry.source : reference?.source;
              const document = entry?.document ?? "ASX filing";
              const date = entry?.date;
              const interest = entry?.interest;
              return (
                <li
                  key={person.slug}
                  className={`${directoryGrid} items-start gap-y-2 py-3 md:items-center md:py-3.5`}
                >
                  <div className="min-w-0">
                    <Link
                      href={investorHref(person.slug)}
                      prefetch={false}
                      className="inline-flex min-w-0 items-center gap-2.5 text-base font-semibold leading-tight underline-offset-4 hover:text-primary hover:underline"
                    >
                      <InvestorThumbnail slug={person.slug} size="directory" />
                      <span>{person.name}</span>
                    </Link>
                    {filedName &&
                      filedNameKey(filedName).replace(
                        /^(?:mr|mrs|ms|dr)\.? +/,
                        "",
                      ) !== filedNameKey(person.name) && (
                        <p className="mt-1 line-clamp-2 break-words text-xs text-muted-foreground">
                          {filedName}
                        </p>
                      )}
                    {entry?.extraAccounts ? (
                      <Link
                        href={investorHref(person.slug) + "#annual-register"}
                        prefetch={false}
                        className="inline-flex min-h-6 items-center text-xs text-primary underline underline-offset-4 hover:decoration-2"
                      >
                        {entry.extraAccounts} more registered{" "}
                        {entry.extraAccounts === 1 ? "account" : "accounts"}
                      </Link>
                    ) : null}
                    {codes.length > 1 && (
                      <p className="mt-1 text-xs text-muted-foreground">
                        {codes.join(" · ")}
                      </p>
                    )}
                  </div>
                  <div className="text-sm font-medium tabular-nums max-md:col-span-2 max-md:row-start-2 md:whitespace-pre-line md:text-right md:text-xs md:font-normal md:text-muted-foreground md:first-line:text-base md:first-line:font-semibold md:first-line:text-foreground">
                    {interest}
                  </div>
                  <div className="text-xs max-md:col-span-2 max-md:row-start-3 md:border-l md:pl-4">
                    {code && (
                      <>
                        <span className="font-medium">{code}</span>
                        {" · "}
                        {source ? (
                          <a
                            href={source}
                            className="text-primary underline underline-offset-4 hover:decoration-2"
                          >
                            {document}
                          </a>
                        ) : (
                          document
                        )}{" "}
                        {date && (
                          <time
                            dateTime={date}
                            className="text-muted-foreground md:mt-1 md:block"
                          >
                            {entry?.yearEnd && "FY ended "}
                            {date}
                          </time>
                        )}
                      </>
                    )}
                  </div>
                  <div className="justify-self-end max-md:col-start-2 max-md:row-start-1">
                    <FollowInvestor slug={person.slug} name={person.name} />
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="mt-3 max-w-3xl text-pretty text-xs text-muted-foreground">
            Voting power includes named associates. Annual figures come from the
            issuer’s register and substantial-holder list.
          </p>
        </div>
      ) : (
        <p>No investor profiles match these filters.</p>
      )}
    </section>
  );
}

export function AustralianInvestorDirectory({ feed }: { feed: Discovery }) {
  const f = useTrackerQuery();
  const followed = useFollowedInvestors();
  const filingsSection = f.view === "filings" || f.view === "following";
  const filings = f.view === "filings" ? selectFilings(feed.rows, f) : [];
  const ranks =
    f.view === "ranks"
      ? (f.largestStake ? ranksByStake : ranksByIssuer).filter((r) =>
          matchesWords(
            `${r.name} ${r.code} ${r.company} ${investorBySlug(r.profile)?.name ?? ""}`,
            f.query,
          ),
        )
      : [];
  const limit = f.page * PAGE_SIZE;
  const filtered =
    f.query ||
    f.issuer ||
    f.event ||
    f.order !== "latest" ||
    f.unread ||
    f.titled ||
    f.largestStake;
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersId = useId();
  const optionCount =
    Number(Boolean(f.event)) +
    Number(f.order !== "latest") +
    Number(f.titled) +
    Number(f.largestStake);
  const clear = filtered && (
    <button
      type="button"
      className={`min-h-10 shrink-0 text-xs ${link}`}
      onClick={() =>
        updateTrackerQuery({ ...defaultView, view: f.view }, !!f.issuer)
      }
    >
      Clear filters
    </button>
  );
  const searchBox = (
    <label className="relative block min-w-0 flex-1">
      <span className="sr-only">Search names or ASX codes</span>
      <Search
        aria-hidden="true"
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <input
        type="search"
        maxLength={200}
        value={f.query}
        onChange={(e) => updateTrackerQuery({ query: e.target.value })}
        placeholder={f.issuer ? "Search investor names" : "Name or ASX code"}
        className={`${control} w-full pl-9 placeholder:text-muted-foreground`}
      />
    </label>
  );
  return (
    <div className="min-w-0 space-y-4">
      <div
        role="group"
        aria-label="Investor discovery views"
        className="flex min-w-0 items-stretch justify-between border-b sm:justify-start sm:gap-x-3"
      >
        {views.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={f.view === value}
            onClick={() => {
              if (value !== f.view) {
                setFiltersOpen(false);
                updateTrackerQuery({ ...defaultView, view: value }, true);
              }
            }}
            aria-label={
              value === "following" ? `Following (${followed.length})` : label
            }
            className="min-h-11 min-w-0 border-b-2 border-transparent px-1 text-left text-xs text-muted-foreground hover:text-foreground aria-pressed:border-primary aria-pressed:font-semibold aria-pressed:text-foreground sm:px-2 sm:text-sm"
          >
            {value === "filings" || value === "ranks" ? (
              <>
                <span className="sm:hidden">
                  {value === "filings" ? "Filings" : "Ranks"}
                </span>
                <span className="hidden sm:inline">{label}</span>
              </>
            ) : value === "following" ? (
              `Following (${followed.length})`
            ) : (
              label
            )}
          </button>
        ))}
      </div>
      {f.view !== "investors" &&
        (f.view !== "following" || followed.length > 0) && (
          <div className="flex flex-wrap items-end gap-2 sm:gap-3">
            <div className="flex min-w-0 flex-1 basis-full items-center gap-2 sm:min-w-56 sm:basis-56">
              {searchBox}
              <button
                type="button"
                aria-expanded={filtersOpen}
                aria-controls={filtersId}
                onClick={() => setFiltersOpen(!filtersOpen)}
                className="inline-flex min-h-10 items-center gap-1.5 rounded-md border px-2.5 text-xs aria-expanded:border-primary sm:hidden"
              >
                <SlidersHorizontal aria-hidden="true" className="size-3.5" />{" "}
                Filters{optionCount > 0 && ` (${optionCount})`}
              </button>
            </div>
            <div
              id={filtersId}
              className={`${filtersOpen ? "grid" : "hidden"} w-full items-end gap-2 sm:flex sm:w-auto sm:flex-wrap sm:gap-3`}
            >
              {filingsSection && (
                <>
                  <label className="grid gap-1 text-xs">
                    Disclosure
                    <select
                      className={control}
                      value={f.event}
                      onChange={(e) =>
                        updateTrackerQuery({
                          event: e.target.value as FilingEvent | "",
                        })
                      }
                    >
                      <option value="">All disclosures</option>
                      {filingEvents.map((event) => (
                        <option key={event} value={event}>
                          {noticeEventLabel(event)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs">
                    Order by
                    <select
                      className={control}
                      value={f.order}
                      onChange={(e) =>
                        updateTrackerQuery({
                          order: e.target.value as FilingOrder,
                        })
                      }
                    >
                      <option value="latest">Latest release</option>
                      <option value="power">
                        Largest reported voting power
                      </option>
                      <option value="move">
                        Largest change in voting power
                      </option>
                    </select>
                  </label>
                </>
              )}
              {f.view === "ranks" && (
                <label className="grid gap-1 text-xs">
                  Order by
                  <select
                    className={control}
                    value={f.largestStake ? "stake" : "rank"}
                    onChange={(e) =>
                      updateTrackerQuery({
                        largestStake: e.target.value === "stake",
                      })
                    }
                  >
                    <option value="rank">Rank on issuer register</option>
                    <option value="stake">Largest share of issuer</option>
                  </select>
                </label>
              )}
              {f.view === "filings" && (
                <label className="flex h-10 items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={f.titled}
                    onChange={(e) =>
                      updateTrackerQuery({ titled: e.target.checked })
                    }
                  />
                  Starts with a personal title
                </label>
              )}
            </div>
            {clear}
          </div>
        )}
      {f.view === "investors" && (
        <People
          feed={feed}
          query={f.query}
          issuer={f.issuer}
          search={searchBox}
          clear={clear}
        />
      )}
      {f.view === "following" && (
        <InvestorWatchlist followed={followed} filters={f} />
      )}
      {f.view === "filings" && (
        <section
          aria-label="Recent substantial holding filings"
          className="space-y-3"
        >
          <h2 className={sectionTitle}>Recent substantial holding filings</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            The latest Form 603, 604 or 605 for each issuer and filed name in
            the last {DISCOVERY_WINDOW} days, from filers outside Shorted’s
            institution directory. Changes are in percentage points (pp).
          </p>
          {feed.status === "unavailable" ? (
            <p role="status">The filings feed is temporarily unavailable.</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {feed.status === "partial" && "Partial coverage. "}
                {feed.read} of {feed.total} notices read · Data through{" "}
                {feed.asOf} · {filings.length} matching{" "}
                {filings.length === 1
                  ? "issuer and name pair"
                  : "issuer and name pairs"}
              </p>
              {f.order === "move" && (
                <p className="text-xs text-muted-foreground">
                  Ranked by absolute change, using filings that give both
                  voting-power figures.
                </p>
              )}
              {filings.length ? (
                <InvestorFilingTable rows={filings.slice(0, limit)} />
              ) : (
                <p>No filings match this search.</p>
              )}
              {limit < filings.length && (
                <button
                  type="button"
                  className={control}
                  onClick={() => updateTrackerQuery({ page: f.page + 1 })}
                >
                  Show more filings
                </button>
              )}
            </>
          )}
        </section>
      )}
      {f.view === "ranks" && (
        <section
          aria-label="Annual shareholder ranks"
          className="min-w-0 space-y-3"
        >
          <h2 className={sectionTitle}>Annual shareholder ranks</h2>
          <p className="max-w-3xl text-sm text-muted-foreground">
            Named entries from {REGISTER_SNAPSHOTS.length} issuers’ largest
            shareholder lists, in the order published. Some entries group
            several accounts.
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
