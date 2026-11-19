"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  investorBySlug,
  investorCodes,
  investorHref,
} from "~/@/lib/ownership/australian-investors";
import {
  filingId,
  followedFilings,
  matchesWords,
  PAGE_SIZE,
  REGISTER_BATCH,
  selectFilings,
  watchCodes,
  type InvestorRegister,
  type SavedInvestor,
} from "~/@/lib/ownership/investor-activity";
import { filerHref } from "~/@/lib/ownership/named-filer";
import { sectionTitle } from "~/@/lib/typography";
import { loadInvestorRegisters } from "~/app/actions/investorWatchlist";
import { FollowInvestor, useReadFilings } from "./investor-follow";
import { InvestorFilingTable } from "./investor-filing-table";
import {
  defaultView,
  updateTrackerQuery,
  type TrackerQuery,
} from "./tracker-query";

const control = "rounded-md border px-3 py-2 text-sm hover:bg-muted";
const link = "text-primary underline-offset-4 hover:underline";

function useIssuerHistories(codesKey: string) {
  const cache = useRef(new Map<string, InvestorRegister>());
  const [registers, setRegisters] = useState<InvestorRegister[]>([]);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const codes = codesKey ? codesKey.split(",") : [];
    const missing = codes.filter((code) => !cache.current.get(code)?.asOf);
    const publish = () =>
      setRegisters(codes.flatMap((code) => cache.current.get(code) ?? []));
    for (const code of missing) cache.current.delete(code);
    publish();
    async function load() {
      for (let offset = 0; offset < missing.length; offset += REGISTER_BATCH) {
        const batch = missing.slice(offset, offset + REGISTER_BATCH);
        let answer: InvestorRegister[];
        try {
          answer = await loadInvestorRegisters(batch);
        } catch {
          answer = [];
        }
        if (!active) return;
        for (const code of batch)
          cache.current.set(
            code,
            answer.find((r) => r.code === code) ?? {
              code,
              asOf: null,
              limited: false,
              notices: [],
            },
          );
        publish();
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [codesKey, attempt]);
  return { registers, retry: () => setAttempt((n) => n + 1) };
}

export function InvestorWatchlist({
  followed,
  filters,
}: {
  followed: SavedInvestor[];
  filters: TrackerQuery;
}) {
  const codes = watchCodes(followed);
  const { registers, retry } = useIssuerHistories(codes.join(","));
  const read = useReadFilings();
  const current = registers.filter((r) => codes.includes(r.code));
  const pending = current.length < codes.length;
  const failed = current.filter((r) => !r.asOf);
  const available = current.filter((r) => r.asOf);
  const all = followedFilings(available, followed);
  const filtered = selectFilings(all, filters).filter(
    (row) => !filters.unread || !read.ids.has(filingId(row)),
  );
  const visible = filtered.slice(0, filters.page * PAGE_SIZE);
  const unreadVisible = visible.map(filingId).filter((id) => !read.ids.has(id));
  const dates = available.map((r) => r.asOf!).sort();
  const newest = dates.at(-1);
  const saved = followed.filter((p) => {
    const person = investorBySlug(p.id);
    return matchesWords(
      [p.name, p.code, ...(person ? investorCodes(person) : [])].join(" "),
      filters.query,
    );
  });
  return (
    <section aria-label="Following" className="space-y-5">
      <header className="space-y-1">
        <h2 className={sectionTitle}>Following</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Releases for your saved names across their ASX issuers. Changes are in
          percentage points (pp). Follows and read status are saved in this
          browser.
        </p>
      </header>
      {!followed.length ? (
        <div className="space-y-3 border-y py-5">
          <p>No followed profiles or filers yet.</p>
          <div className="flex flex-wrap gap-2">
            <button
              className={control}
              type="button"
              onClick={() => updateTrackerQuery({ ...defaultView }, true)}
            >
              Browse investors
            </button>
            <button
              className={control}
              type="button"
              onClick={() =>
                updateTrackerQuery({ ...defaultView, view: "filings" }, true)
              }
            >
              Browse recent filings
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm" role="status">
              {filtered.length} matching{" "}
              {filtered.length === 1 ? "filing" : "filings"} ·{" "}
              {available.length} of {codes.length} issuer{" "}
              {codes.length === 1 ? "register" : "registers"} loaded
              {pending && " · Loading…"}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={filters.unread}
                  onChange={(e) =>
                    updateTrackerQuery({ unread: e.target.checked })
                  }
                />
                Unread only
              </label>
              {unreadVisible.length > 0 && (
                <button
                  type="button"
                  className={control}
                  onClick={() => read.mark(unreadVisible, true)}
                >
                  Mark shown as read
                </button>
              )}
            </div>
          </div>
          {read.error && (
            <p role="status" className="text-sm">
              Read status could not be saved in this browser.
            </p>
          )}
          {failed.length > 0 && (
            <p className="text-sm">
              Registers unavailable for {failed.map((r) => r.code).join(", ")}.{" "}
              <button type="button" onClick={retry} className={link}>
                Retry unavailable registers
              </button>
            </p>
          )}
          {visible.length ? (
            <InvestorFilingTable rows={visible} readState={read} />
          ) : (
            !pending &&
            available.length > 0 && (
              <p className="border-y py-4 text-sm">
                {filters.unread
                  ? "No unread filings match this view."
                  : "No filings match in the available issuer histories."}
              </p>
            )
          )}
          {filtered.length > visible.length && (
            <button
              className={control}
              type="button"
              onClick={() => updateTrackerQuery({ page: filters.page + 1 })}
            >
              Show more filings
            </button>
          )}
          {newest && (
            <p className="text-xs text-muted-foreground">
              Register data through{" "}
              {dates[0] === newest ? newest : `${dates[0]} to ${newest}`}.
              {available.some((r) => r.limited) &&
                ` History is limited to the latest 100 issuer notices for ${available
                  .filter((r) => r.limited)
                  .map((r) => r.code)
                  .join(", ")}.`}
            </p>
          )}
          <div className="space-y-2">
            <h3 className="font-semibold">Saved investors and filers</h3>
            {!saved.length && (
              <p className="text-sm text-muted-foreground">
                No saved names match this search.
              </p>
            )}
            <ul className="divide-y border-y">
              {saved.map((s) => (
                <li
                  key={s.id}
                  className="flex items-start justify-between gap-3 py-2"
                >
                  <div className="min-w-0">
                    <Link
                      href={
                        s.code ? filerHref(s.code, s.name) : investorHref(s.id)
                      }
                      prefetch={false}
                      className={link}
                    >
                      {s.name}
                    </Link>
                    {s.code && (
                      <span className="block text-xs text-muted-foreground">
                        {s.code} · Filed name
                        {s.source && (
                          <>
                            {" "}
                            ·{" "}
                            <a href={s.source} className={link}>
                              Saved filing
                            </a>
                          </>
                        )}
                      </span>
                    )}
                  </div>
                  {s.code ? (
                    <FollowInvestor
                      code={s.code}
                      name={s.name}
                      source={s.source}
                    />
                  ) : (
                    <FollowInvestor slug={s.id} name={s.name} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </section>
  );
}
