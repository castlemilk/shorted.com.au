"use client";

import Link from "next/link";
import dynamic from "next/dynamic";
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

function People({ feed, query }: { feed: Discovery; query: string }) {
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
      <h2 className={sectionTitle}>People named in disclosures</h2>
      <p className="text-sm text-muted-foreground">
        {matches.length} matching{" "}
        {matches.length === 1 ? "profile" : "profiles"}. Each entry shows the
        latest matching notice in the {DISCOVERY_WINDOW}-day feed or a named
        account from an annual register.
      </p>
      {matches.length ? (
        <ul className="divide-y border-y">
          {matches.map(({ person, codes, rank }) => {
            const notice = latest.get(person.slug);
            const filedName = notice?.name ?? rank?.name;
            return (
              <li
                key={person.slug}
                className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(14rem,0.8fr)_auto] sm:items-center"
              >
                <div className="min-w-0">
                  <Link
                    href={investorHref(person.slug)}
                    prefetch={false}
                    className={`font-medium ${link}`}
                  >
                    {person.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {codes.join(" · ")}
                  </p>
                </div>
                <div className="col-span-2 min-w-0 text-sm max-sm:row-start-2 sm:col-span-1 sm:col-start-2 sm:row-start-1">
                  {notice ? (
                    <>
                      <span className="font-medium tabular-nums">
                        {notice.ceased
                          ? "Ceased to be substantial"
                          : notice.pct === null
                            ? "Voting power unstated"
                            : `${investorPct(notice.pct)} voting power`}
                      </span>
                      <span className="block text-xs text-muted-foreground">
                        {notice.code} ·{" "}
                        {notice.source ? (
                          <a href={notice.source} className={link}>
                            Form {notice.form}
                          </a>
                        ) : (
                          `Form ${notice.form}`
                        )}{" "}
                        · {notice.date}
                      </span>
                    </>
                  ) : (
                    rank && (
                      <>
                        <span className="font-medium tabular-nums">
                          #{rank.rank} · {investorPct(rank.pct)} of issued
                          shares
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {rank.code} ·{" "}
                          <a href={rank.source} className={link}>
                            Annual register
                          </a>{" "}
                          · {rank.date}
                        </span>
                      </>
                    )
                  )}
                  {filedName &&
                    filedNameKey(filedName) !== filedNameKey(person.name) && (
                      <span className="mt-0.5 block break-words text-xs text-muted-foreground">
                        {filedName}
                      </span>
                    )}
                </div>
                <div className="col-start-2 row-start-1 sm:col-start-3">
                  <FollowInvestor slug={person.slug} name={person.name} />
                </div>
              </li>
            );
          })}
        </ul>
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
  return (
    <div className="min-w-0 space-y-5">
      <div
        role="group"
        aria-label="Investor discovery views"
        className="grid grid-cols-2 gap-x-1 border-b sm:flex"
      >
        {views.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            aria-pressed={f.view === value}
            onClick={() => {
              if (value !== f.view)
                updateTrackerQuery({ ...defaultView, view: value }, true);
            }}
            className="border-b-2 border-transparent px-3 py-2 text-left text-sm text-muted-foreground aria-pressed:border-primary aria-pressed:font-semibold aria-pressed:text-foreground"
          >
            {value === "following" ? `Following (${followed.length})` : label}
          </button>
        ))}
      </div>
      {(f.view !== "following" || followed.length > 0) && (
        <div className="flex flex-wrap items-end gap-3">
          <label className="grid min-w-[min(100%,14rem)] flex-1 gap-1 text-xs">
            Search names or ASX codes
            <input
              type="search"
              maxLength={200}
              value={f.query}
              placeholder="e.g. Maas, RealWise or HVN"
              onChange={(e) => updateTrackerQuery({ query: e.target.value })}
              className={control}
            />
          </label>
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
                    updateTrackerQuery({ order: e.target.value as FilingOrder })
                  }
                >
                  <option value="latest">Latest release</option>
                  <option value="power">Largest reported voting power</option>
                  <option value="move">Largest change in voting power</option>
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
          {filtered && (
            <button
              type="button"
              className={`h-10 text-xs ${link}`}
              onClick={() =>
                updateTrackerQuery({ ...defaultView, view: f.view })
              }
            >
              Clear filters
            </button>
          )}
        </div>
      )}
      {f.view === "investors" && <People feed={feed} query={f.query} />}
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
