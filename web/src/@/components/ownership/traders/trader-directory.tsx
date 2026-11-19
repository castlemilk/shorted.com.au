"use client";

import { InvestorThumbnail } from "./investor-thumbnail";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowUpRight, Search } from "lucide-react";
import {
  ASX_CODE,
  directorHref,
  TRADERS,
  traderHref,
} from "~/@/lib/ownership/traders";
import { sectionTitle } from "~/@/lib/typography";

export function TraderDirectory() {
  const [query, setQuery] = useState("");
  const [code, setCode] = useState("");
  const router = useRouter();
  const search = query.trim().toLowerCase();
  const visible = TRADERS.filter((p) =>
    `${p.name} ${p.firm}`.toLowerCase().includes(search),
  );

  return (
    <div className="grid items-start gap-10 lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
      <section aria-labelledby="manager-heading" className="min-w-0">
        <h2 id="manager-heading" className={sectionTitle}>
          Investment managers
        </h2>
        <label className="relative mt-4 block">
          <span className="sr-only">Find a manager or firm</span>
          <Search
            className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground"
            aria-hidden
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a manager or firm"
            className="h-10 w-full rounded-md border bg-background pl-10 pr-3 text-sm"
          />
        </label>
        <ul className="mt-5 divide-y border-y">
          {visible.map((p) => (
            <li key={p.slug}>
              <a
                href={traderHref(p)}
                className="group grid grid-cols-[1fr_auto] items-center gap-3 px-1 py-4 hover:bg-muted/30 focus-visible:outline-primary"
              >
                <span className="flex min-w-0 items-center gap-3">
                  <InvestorThumbnail slug={p.slug} size="graph" />
                  <span className="min-w-0">
                    <span className="block font-serif text-xl font-semibold group-hover:text-primary">
                      {p.name}
                    </span>
                    <span className="block text-sm text-muted-foreground">
                      {p.firm}
                    </span>
                  </span>
                </span>
                <span className="flex items-center gap-2 text-xs text-muted-foreground">
                  {p.reporting.market === "ASX" ? "ASX notices" : "SEC 13F"}
                  <ArrowUpRight aria-hidden className="h-4 w-4" />
                </span>
              </a>
            </li>
          ))}
        </ul>
        {!visible.length && (
          <p role="status" className="mt-4 text-sm text-muted-foreground">
            No tracked manager or firm matches this search.
          </p>
        )}
      </section>
      <aside className="space-y-4 border-t pt-5 lg:border-l lg:border-t-0 lg:pl-8 lg:pt-0">
        <h2 className={sectionTitle}>ASX directors</h2>
        <p className="text-sm text-muted-foreground">
          Look up a company, then select a director to see changes reported in
          its Appendix 3Y filings.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const ticker = code.trim().toUpperCase();
            if (ASX_CODE.test(ticker)) router.push(directorHref(ticker));
          }}
        >
          <label htmlFor="trader-stock" className="block text-sm font-medium">
            ASX code
          </label>
          <div className="mt-2 flex gap-2">
            <input
              id="trader-stock"
              required
              pattern="[A-Za-z0-9]{3,4}"
              maxLength={4}
              placeholder="e.g. BHP"
              autoCapitalize="characters"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              title="Enter a three or four character ASX code"
              className="h-10 min-w-0 flex-1 rounded-md border bg-background px-3 uppercase"
            />
            <button className="rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground">
              Find directors
            </button>
          </div>
        </form>
        <Link
          href="/insider-trading"
          prefetch={false}
          className="inline-block text-sm text-primary underline-offset-4 hover:underline"
        >
          Browse companies →
        </Link>
      </aside>
    </div>
  );
}
