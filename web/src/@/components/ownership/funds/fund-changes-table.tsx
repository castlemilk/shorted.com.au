"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { sectionTitle } from "@/lib/typography";
import { parseSelection } from "../workspace/selection";
import { Toolbar } from "../workspace/toolbar";
import { ViewDisclosure } from "../workspace/view-disclosure";
import { StockLogoBox } from "../workspace/stock-logo-box";
import { withUrlState, type UrlState } from "./url-params";
import {
  CHANGE_FILTERS,
  CHANGE_FILTER_LABELS,
  changesCsv,
  cleanFundKey,
  cleanIsoDate,
  defaultPair,
  filterChanges,
  formatDeltaPp,
  formatWeight,
  patchHref,
  statusLabel,
  type ChangeFilter,
  type CompareRow,
  type FundComparison,
  type LoadFundComparison,
  type LoadFundPortfolio,
} from "./fund-model";

export interface ChangeFundOption {
  key: string;
  ticker: string;
  name: string;
}

export interface FundChangesTableProps {
  funds: readonly ChangeFundOption[];
  /** The fund and the two file dates the page asked for. */
  defaults: { fund: string; from: string; to: string };
  /** The default fund's file dates, oldest first. */
  defaultDates: readonly string[];
  /** The comparison of the defaults, read on the server. */
  initial: FundComparison;
  loadPortfolio: LoadFundPortfolio;
  compare: LoadFundComparison;
}

interface Loaded {
  key: string;
  page: FundComparison;
}

const FILTER_KEYS = CHANGE_FILTERS as readonly string[];

/**
 * The changes table for two files of one fund (spec 14.3, Changes): the fund and the
 * two dates, the filter chips, the CSV built from the rows shown, and the rows. A
 * company links to its holding's selection, which the inspector reads.
 */
export function FundChangesTableView({
  funds,
  defaults,
  defaultDates,
  initial,
  loadPortfolio,
  compare,
  params,
  pathname,
  navigate,
}: FundChangesTableProps & UrlState) {
  const picked = cleanFundKey(params.get("fund"));
  const fund = funds.some((option) => option.key === picked) ? picked : defaults.fund;
  const isDefault = fund === defaults.fund;
  // A fund other than the default has its file dates read on arrival, so a shared
  // link or a pick names its two newest files without the page having read them.
  const [loadedDates, setLoadedDates] = useState<{ fund: string; dates: string[] } | null>(null);
  const loadedFund = loadedDates?.fund;
  useEffect(() => {
    if (isDefault || loadedFund === fund) return;
    let live = true;
    void loadPortfolio({ fundKey: fund }).then((read) => {
      // An unreadable fund is recorded with no dates, so the table says so rather than loading.
      if (live) setLoadedDates({ fund, dates: read.ok ? (read.fund?.snapshotDates ?? []) : [] });
    });
    return () => {
      live = false;
    };
  }, [fund, isDefault, loadedFund, loadPortfolio]);
  const datesReady = isDefault || loadedFund === fund;
  const dates = isDefault ? [...defaultDates] : loadedDates?.fund === fund ? loadedDates.dates : [];
  const auto = defaultPair(dates);
  const from = cleanIsoDate(params.get("from")) || (isDefault ? defaults.from : auto.from);
  const to = cleanIsoDate(params.get("to")) || (isDefault ? defaults.to : auto.to);
  // A fund other than the default takes its two newest files once they are read. The URL
  // is written with them (replace, no scroll), so the rail and a shared link resolve the
  // same comparison the table shows.
  const adoptDates =
    !isDefault && datesReady && auto.from !== "" && auto.to !== "" &&
    (cleanIsoDate(params.get("from")) === "" || cleanIsoDate(params.get("to")) === "");
  // The URL is rebuilt on every render, so the effect keys on its text and names the pair it adopted.
  const query = params.toString();
  const adopted = useRef("");
  useEffect(() => {
    if (!adoptDates) return;
    const target = `${fund}|${auto.from}|${auto.to}`;
    if (adopted.current === target) return;
    adopted.current = target;
    navigate(patchHref(pathname, new URLSearchParams(query), { from: auto.from, to: auto.to }));
  }, [adoptDates, auto.from, auto.to, fund, navigate, pathname, query]);
  const filterParam = params.get("filter") ?? "all";
  const filter: ChangeFilter = FILTER_KEYS.includes(filterParam) ? (filterParam as ChangeFilter) : "all";

  const key = `${fund}|${from}|${to}`;
  const initialKey = `${defaults.fund}|${defaults.from}|${defaults.to}`;
  // An earlier file after the later one is not a comparison: the table says so and reads nothing.
  const inverted = from !== "" && to !== "" && from > to;
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  useEffect(() => {
    if (key === initialKey || from === "" || to === "" || inverted) return;
    let live = true;
    void compare({ fundKey: fund, from, to }).then((page) => {
      if (live) setLoaded({ key, page });
    });
    return () => {
      live = false;
    };
  }, [key, initialKey, fund, from, to, compare, inverted]);
  const page: FundComparison | null = key === initialKey ? initial : loaded?.key === key ? loaded.page : null;
  const rows: CompareRow[] = page?.ok ? page.rows : [];
  const shown = filterChanges(rows, filter);
  // The selected holding of this fund is outlined (spec 14.1), as the exposure map outlines its row.
  const selection = parseSelection(params.get("sel") ?? "");
  const selectedCode = selection?.kind === "holding" && selection.fundKey === fund ? selection.code : "";
  // A date the URL names but the fund does not hold is still an option, so the select shows what is compared.
  const dateOptions = dates.length === 0 ? [] : [...new Set([...dates, from, to].filter((date) => date !== ""))].sort();

  /** A new fund: the dates are read by the effect above, and the two newest files shown. */
  const pickFund = (next: string) =>
    navigate(
      patchHref(pathname, params, {
        fund: next === defaults.fund ? null : next,
        from: null,
        to: null,
        sel: null,
      }),
    );

  /** A new date changes the rows, so the selection it held (and its figures) is cleared. */
  const pickDate = (name: "from" | "to", value: string) => navigate(patchHref(pathname, params, { [name]: value, sel: null }));

  const exportCsv = () => {
    const blob = new Blob([changesCsv(shown)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${fund}-changes-${from || "earlier"}-${to || "later"}.csv`;
    link.click();
    // The link must have started the download before the object URL is released.
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const selectClass =
    "h-10 rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground disabled:opacity-50 w-full min-w-0 max-w-full sm:w-auto";

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h2 className={sectionTitle}>Changes in portfolio weight</h2>
        <p className="text-sm text-muted-foreground">Reported snapshot change. Not a trade record.</p>
      </div>

      {/* One toolbar row (spec 14.9): the fund, the two snapshots and the filter, under "Adjust view" below sm. */}
      <Toolbar fold={(row) => <ViewDisclosure>{row}</ViewDisclosure>}>
        <label className="flex min-w-0 max-w-full flex-col gap-1 font-mono text-xs text-muted-foreground">
          Fund
          <select aria-label="Fund" value={fund} onChange={(event) => void pickFund(event.target.value)} className={selectClass}>
            {funds.map((option) => (
              <option key={option.key} value={option.key}>
                {option.ticker.trim() !== "" ? `${option.ticker} · ${option.name}` : option.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 max-w-full flex-col gap-1 font-mono text-xs text-muted-foreground">
          Earlier snapshot
          <select
            aria-label="Earlier snapshot"
            value={from}
            disabled={dates.length === 0}
            onChange={(event) => pickDate("from", event.target.value)}
            className={selectClass}
          >
            {dateOptions.map((date) => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 max-w-full flex-col gap-1 font-mono text-xs text-muted-foreground">
          Later snapshot
          <select
            aria-label="Later snapshot"
            value={to}
            disabled={dates.length === 0}
            onChange={(event) => pickDate("to", event.target.value)}
            className={selectClass}
          >
            {dateOptions.map((date) => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-0 max-w-full flex-col gap-1 font-mono text-xs text-muted-foreground">
          Show
          <select
            aria-label="Show changes"
            value={filter}
            onChange={(event) => navigate(patchHref(pathname, params, { filter: event.target.value === "all" ? null : event.target.value }))}
            className={selectClass}
          >
            {CHANGE_FILTERS.map((option) => (
              <option key={option} value={option}>
                {CHANGE_FILTER_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={exportCsv}
          disabled={shown.length === 0}
          className="h-10 rounded-md border border-border px-3 font-mono text-xs hover:border-primary disabled:opacity-50"
        >
          Export CSV
        </button>
        <p className="pb-2 font-mono text-xs text-muted-foreground">Exact file dates shown · Comparable holdings only</p>
      </Toolbar>

      {inverted ? (
        <p className="text-muted-foreground">The earlier snapshot must be before the later one.</p>
      ) : !datesReady || (page === null && from !== "" && to !== "") ? (
        <p role="status" aria-busy="true" aria-label="Loading" className="text-muted-foreground">
          Loading…
        </p>
      ) : from === "" || to === "" ? (
        <p className="text-muted-foreground">Two file dates of this fund are needed to compare them.</p>
      ) : page === null ? (
        <p role="status" aria-busy="true" aria-label="Loading" className="text-muted-foreground">
          Loading…
        </p>
      ) : !page.ok ? (
        <p className="text-muted-foreground">
          {page.error
            ? page.error
            : "The comparison could not be read just now. Nothing here is missing from the register: this is our end."}
        </p>
      ) : shown.length === 0 ? (
        <p className="text-muted-foreground">No holdings match this filter for these files.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[40rem] border-collapse font-mono text-sm">
            <caption className="sr-only">
              Weight in {fund} at {from} and {to}, by company
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-2 py-2 font-normal">Company</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">{from}</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">{to}</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Change (pp)</th>
                <th scope="col" className="px-2 py-2 font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => {
                const rise = row.deltaPp !== null && row.deltaPp > 0;
                return (
                  <Fragment key={row.code}>
                  <tr
                    aria-current={row.code === selectedCode ? "true" : undefined}
                    className={cn(
                      "border-b border-border last:border-0",
                      row.code === selectedCode && "bg-muted/40 outline outline-1 -outline-offset-1 outline-primary",
                    )}
                  >
                    <td className="px-2 py-2">
                      <span className="flex items-center gap-2">
                        <StockLogoBox code={row.code} size={20} />
                        <Link
                          href={patchHref(pathname, params, { sel: `holding:${fund}/${row.code}` })}
                          scroll={false}
                          prefetch={false}
                          className="font-semibold underline-offset-4 hover:underline"
                        >
                          {row.code}
                        </Link>
                        <span className="hidden truncate text-muted-foreground sm:inline">{row.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatWeight(row.weightFrom)}</td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatWeight(row.weightTo)}</td>
                    <td className={cn("px-2 py-2 text-right tabular-nums", rise ? "text-primary" : "text-foreground")}>
                      {formatDeltaPp(row.deltaPp)}
                    </td>
                    <td className="px-2 py-2 text-muted-foreground">{statusLabel(row.status)}</td>
                  </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted-foreground">Weight changes can reflect price moves.</p>
    </div>
  );
}

/** The changes table, reading its fund and dates from the URL under its own boundary. */
export const FundChangesTable = withUrlState(FundChangesTableView);
