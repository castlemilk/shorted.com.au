"use client";

import { Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  filedNameKey,
  investorForFiling,
  investorHref,
  investorPct,
} from "~/@/lib/ownership/australian-investors";
import type { DisclosureRow } from "~/@/lib/ownership/investor-disclosures";
import { filerHref, filerPath } from "~/@/lib/ownership/named-filer";
import { registerHref } from "~/@/lib/ownership/kinds";
import { FilingHistory } from "./filing-history";
import { FollowInvestor } from "./investor-follow";

type Props = {
  code: string;
  current: {
    name: string;
    pct: number;
    date: string;
    source?: string;
    votes?: string;
  }[];
  history: DisclosureRow[];
  limited: boolean;
};

function NameView({
  code,
  current,
  history,
  limited,
  selected,
}: Props & { selected: string }) {
  const names = new Map<string, string>();
  for (const r of [...current, ...history]) {
    if (r.name.trim() && !names.has(filedNameKey(r.name)))
      names.set(filedNameKey(r.name), r.name);
  }
  const key = filedNameKey(selected);
  const name = names.get(key);
  const holding = current.find((r) => filedNameKey(r.name) === key);
  const notices = history.filter((r) => filedNameKey(r.name) === key);
  const profile = name && investorForFiling(code, name);
  return (
    <div className="space-y-4">
      <label className="grid max-w-xl gap-1 text-sm">
        Filed name
        <select
          value={name ?? ""}
          className="max-w-full rounded-md border bg-background p-2"
          onChange={(e) =>
            window.history.pushState(
              null,
              "",
              e.target.value
                ? filerHref(code, e.target.value)
                : filerPath(code),
            )
          }
        >
          <option value="">Select a filed name</option>
          {[...names.values()]
            .sort((a, b) => a.localeCompare(b))
            .map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
        </select>
      </label>
      {selected && !name && (
        <p>
          This name has no matching record in the available {code} register and
          recent filing history.
        </p>
      )}
      {name && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3 border-y py-4">
            <div className="min-w-0">
              <h2 className="break-words font-serif text-2xl font-semibold">
                {name}
              </h2>
              <p className="mt-1 text-sm">
                {holding ? (
                  <>
                    {investorPct(holding.pct)} reported voting power
                    {holding.votes && ` · ${holding.votes} votes`} ·{" "}
                    {holding.source ? (
                      <a
                        href={holding.source}
                        className="text-primary hover:underline"
                      >
                        Filed {holding.date}
                      </a>
                    ) : (
                      `Filed ${holding.date}`
                    )}
                  </>
                ) : (
                  "No current matching substantial interest in this register."
                )}
              </p>
              {profile && (
                <Link
                  href={investorHref(profile.slug)}
                  prefetch={false}
                  className="text-sm text-primary hover:underline"
                >
                  {profile.name} · investor profile →
                </Link>
              )}
            </div>
            {profile ? (
              <FollowInvestor slug={profile.slug} name={profile.name} />
            ) : (
              <FollowInvestor
                code={code}
                name={name}
                source={holding?.source ?? notices[0]?.source ?? undefined}
              />
            )}
          </div>
          <h3 className="font-semibold">Filing history</h3>
          {notices.length ? (
            <FilingHistory rows={notices} />
          ) : (
            <p>No matching releases in the available history.</p>
          )}
        </>
      )}
      {limited && (
        <p className="text-sm text-muted-foreground">
          History covers the issuer’s latest 100 notices.
        </p>
      )}
      <Link
        prefetch={false}
        href={registerHref(code)}
        className="text-sm text-primary hover:underline"
      >
        Full company ownership register →
      </Link>
    </div>
  );
}

function SelectedFiler(props: Props) {
  const params = useSearchParams();
  return <NameView {...props} selected={params.get("name") ?? ""} />;
}

export function NamedFilerRegister(props: Props) {
  return (
    <Suspense fallback={<NameView {...props} selected="" />}>
      <SelectedFiler {...props} />
    </Suspense>
  );
}
