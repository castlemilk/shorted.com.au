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
  DISCOVERY_WINDOW,
  type Discovery,
  type DisclosureRow,
} from "~/@/lib/ownership/investor-disclosures";
import { noticeEventLabel } from "~/@/lib/ownership/events";
import { sectionTitle } from "~/@/lib/typography";
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
const profiles = AUSTRALIAN_INVESTORS.map((p) => {
  const codes = investorCodes(p);
  const ranks = ranksForInvestor(p.slug).sort(
    (a, b) => b.date.localeCompare(a.date) || a.rank - b.rank,
  );
  return {
    person: p,
    codes,
    rank: ranks[0],
    search: [
      p.name,
      ...(p.alternateName ? [p.alternateName] : []),
      ...codes,
      ...p.filings.map((f) => f.filedName),
      ...ranks.flatMap((r) => [r.name, r.company]),
    ].join(" "),
  };
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
  search,
}: {
  feed: Discovery;
  query: string;
  search: ReactNode;
}) {
  const latest = new Map<string, DisclosureRow>();
  const companies = new Map<string, string>();
  for (const row of feed.rows) {
    if (row.profile && !latest.has(row.profile)) latest.set(row.profile, row);
    if (row.company) companies.set(row.code, row.company);
  }
  const matches = profiles.filter((p) =>
    matchesWords(
      [p.search, ...p.codes.map((code) => companies.get(code))].join(" "),
      query,
    ),
  );
  return (
    <section aria-label="Investor profiles" className="space-y-3">
      <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
        <h2 className={sectionTitle}>
          {matches.length} investor{" "}
          {matches.length === 1 ? "profile" : "profiles"}
        </h2>
        {search}
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
            {matches.map(({ person, codes, rank }) => {
              const notice = latest.get(person.slug);
              const filedName = notice?.name ?? rank?.name;
              const code = notice?.code ?? rank?.code;
              const date = notice?.date ?? rank?.date;
              const source = notice ? notice.source : rank?.source;
              const document = notice
                ? `Form ${notice.form}`
                : "Annual register";
              const interest = notice
                ? notice.ceased
                  ? "Ceased to be substantial"
                  : notice.pct === null
                    ? "Voting power unstated"
                    : `${investorPct(notice.pct)}\nvoting power`
                : rank &&
                  `#${rank.rank} · ${investorPct(rank.pct)}\nof issued shares`;
              return (
                <li
                  key={person.slug}
                  className={`${directoryGrid} items-start gap-y-2 py-3 md:items-center md:py-3.5`}
                >
                  <div className="min-w-0">
                    <Link
                      href={investorHref(person.slug)}
                      prefetch={false}
                      className="text-base font-semibold leading-tight underline-offset-4 hover:text-primary hover:underline"
                    >
                      {person.name}
                    </Link>
                    {filedName &&
                      filedNameKey(filedName).replace(
                        /^(?:mr|mrs|ms)\.? +/,
                        "",
                      ) !== filedNameKey(person.name) && (
                        <p className="mt-1 break-words text-xs text-muted-foreground">
                          {filedName}
                        </p>
                      )}
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
                          <a href={source} className={link}>
                            {document}
                          </a>
                        ) : (
                          document
                        )}{" "}
                        <time
                          dateTime={date}
                          className="text-muted-foreground md:mt-1 md:block"
                        >
                          {date}
                        </time>
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
          <p className="mt-3 max-w-3xl text-xs text-muted-foreground">
            Each profile shows its latest matched notice in the{" "}
            {DISCOVERY_WINDOW}-day feed or a named account from an annual
            register.
          </p>
        </div>
      ) : (
        <p>
          No investor profiles match. Search Recent filings for other names.
        </p>
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
      onClick={() => updateTrackerQuery({ ...defaultView, view: f.view })}
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
        placeholder="Search names or ASX codes"
        className={`${control} w-full pl-9`}
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
          search={
            <div className="flex w-full items-center gap-3 sm:w-80">
              {searchBox}
              {clear}
            </div>
          }
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
            Selected named accounts from {REGISTER_SNAPSHOTS.length} issuers’
            top-20 registers. Each rank belongs to one registered account on the
            date shown.
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
