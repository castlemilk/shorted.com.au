"use client";

import Link from "next/link";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { sectionTitle } from "@/lib/typography";
import { NOT_AVAILABLE, formatPct } from "~/@/lib/fundamentals/format";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { binFill, binOf, labelOnBin, lensFill, type LensScale } from "../desk/desk-scales";
import { HolderLogo } from "../workspace/holder-logo";
import { SortControl } from "../workspace/sort-control";
import { TOOLBAR_SELECT_CLASS, Toolbar, ToolbarSelect } from "../workspace/toolbar";
import { ViewDisclosure } from "../workspace/view-disclosure";
import { SectorIcon } from "../workspace/sector-icon";
import { StockLogoBox } from "../workspace/stock-logo-box";
import { FigureList } from "./row-disclosure";
import { EXPANDER_HEADER, ExpandableRow } from "./expandable-row";
import { shortSector } from "~/@/lib/ownership/kinds";
import { withUrlState, type UrlState } from "./url-params";
import { DEFAULT_DESK_SORT, readDeskState, type DeskSort } from "../desk/desk-state";
import {
  FUND_COMPARE_MAX,
  fundKindLabel,
  formatWeight,
  orderFundsForSort,
  otherWeightOf,
  parseFundKeys,
  patchHref,
  sectorChangeDetail,
  sectorColumns,
  sectorWeightOf,
  serializeFundKeys,
  toggleFundKey,
  type FundRow,
  fundLabel,
} from "./fund-model";

/**
 * The weight ramp (spec 14.3, 13.1): the desk's sequential scale over 0% to 40%, five bins of 8 points.
 * A cell is one of the five stops every instrument draws, and a weight above 40% reads in the top bin.
 */
const WEIGHT_SCALE: LensScale = { lens: "disclosed", mode: "sequential", lo: 0, hi: 40, step: 8 };
const LEGEND_BINS = [0, 1, 2, 3, 4] as const;
const LEGEND_COPY = "Cell colour and value = weight within that fund";
/** The page header's status line (spec 14.7); the page prints it beside its title. */
export const FUND_STATUS_COPY = "Tracked portfolios only · Snapshot dates vary";

/**
 * The toolbar's selects (spec 14.9, backlog B3). Each option's label is its visible text; the
 * value is what the URL carries, and the default value is the one that writes no parameter.
 */
const KIND_OPTIONS = [
  { value: "index", label: "Index funds" },
  { value: "super", label: "Super options" },
] as const;
const VIEW_OPTIONS = [
  { value: "sectors", label: "Sector weights" },
  { value: "holdings", label: "Holdings" },
] as const;
const FILES_OPTIONS = [
  { value: "files", label: "Available" },
  { value: "all", label: "All tracked" },
] as const;

/**
 * A fund row's height (backlog B3): one line of logo, ticker, tag and manager, centred in 44 px.
 * The chevron's cell is top-aligned by the shared expander, so the row centres its cells itself.
 */
const FUND_ROW_CLASS = "h-11 [&>td]:align-middle";

export interface FundExposureMapProps {
  funds: readonly FundRow[];
}

/** Whether a fund has a file to read: a file date and the source it came from. */
export function fundHasFile(fund: FundRow): boolean {
  return fund.asAt !== "" && fund.sourceUrl !== "";
}

/** Whether a fund matches the search: its code, name or manager, case-blind. */
export function fundMatches(fund: FundRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === "") return true;
  return [fund.ticker, fund.name, fund.institutionName].some((field) => field.toLowerCase().includes(q));
}

/**
 * The fund exposure map (spec 14.3, Funds): one row per fund, a checkbox to compare
 * up to three, the weight of each of the six largest sectors and of the rest, each
 * cell tinted on one scale. A toggle shows the funds' ten largest positions
 * instead. The selection is `?funds=`, the type `?type=`, the view `?view=`, the
 * manager `?manager=`, the coverage `?coverage=`; a click on a fund selects it in
 * the URL (`?sel=fund:KEY`) for the inspector. Every row expands to its figures.
 */
export function FundExposureMapView({
  funds,
  params,
  pathname,
  navigate,
}: FundExposureMapProps & UrlState) {
  const [query, setQuery] = useState("");
  const type = params.get("type") === "super" ? "super" : "index";
  const view = params.get("view") === "holdings" ? "holdings" : "sectors";
  const manager = params.get("manager") ?? "";
  const coverage = params.get("coverage") === "all" ? "all" : "files";
  const selected = parseFundKeys(params.get("funds"));
  const sel = params.get("sel") ?? "";
  // The sort orders the fund rows of both views (backlog C3b): "changed" puts the largest sector moves first.
  const sort: DeskSort = readDeskState(params).sort;
  const byType = funds.filter((fund) => (type === "super" ? fund.sourceKind === "super_phd" : fund.sourceKind !== "super_phd"));
  const managers = [...new Set(byType.map((fund) => fund.institutionName).filter((name) => name !== ""))].sort();
  const visible = orderFundsForSort(
    byType.filter(
      (fund) =>
        fundMatches(fund, query) &&
        (manager === "" || fund.institutionName === manager) &&
        (coverage === "all" || fundHasFile(fund)),
    ),
    sort,
  );
  const columns = sectorColumns(visible);
  const full = selected.length >= FUND_COMPARE_MAX;
  const tickerOf = (key: string) => {
    const fund = funds.find((row) => row.key === key);
    return fund ? fundLabel(fund) : key;
  };

  const setSelected = (keys: readonly string[]) => navigate(patchHref(pathname, params, { funds: serializeFundKeys(keys) }));

  return (
    <div className="space-y-4">
      <h2 className={sectionTitle}>Fund exposure map</h2>

      {/*
        One toolbar row (spec 14.9, backlog B3): the search, then four labelled selects, under "Adjust view"
        below sm. Each select writes the same parameter the segmented controls wrote before.
      */}
      <Toolbar fold={(row) => <ViewDisclosure>{row}</ViewDisclosure>}>
        {/*
          The search takes the row's spare width. Its 10 rem basis is what makes the row break before the
          selects overflow: with the Manager select at its 12 rem cap (the super managers' longest name) the
          controls use about 953 px of the 1016 px column at 1440, so the search grows into the rest and the
          placeholder shows whole; a fixed width would push Files onto a second line.
        */}
        <input
          type="search"
          aria-label="Find fund, code or manager"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="A200, Vanguard, Betashares"
          className={cn(TOOLBAR_SELECT_CLASS, "min-w-[10rem] max-w-[16rem] flex-1 placeholder:text-muted-foreground")}
        />
        <ToolbarSelect
          label="Manager"
          value={manager}
          onChange={(value) => navigate(patchHref(pathname, params, { manager: value || null }))}
          className="max-w-[12rem] truncate"
        >
          <option value="">All managers</option>
          {managers.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </ToolbarSelect>
        <ToolbarSelect
          label="Kind"
          value={type}
          onChange={(value) => navigate(patchHref(pathname, params, { type: value === "index" ? null : value }))}
        >
          {KIND_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </ToolbarSelect>
        <ToolbarSelect
          label="View"
          value={view}
          onChange={(value) => navigate(patchHref(pathname, params, { view: value === "sectors" ? null : value }))}
        >
          {VIEW_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </ToolbarSelect>
        <ToolbarSelect
          label="Files"
          value={coverage}
          onChange={(value) => navigate(patchHref(pathname, params, { coverage: value === "files" ? null : value }))}
        >
          {FILES_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </ToolbarSelect>
        <SortControl
          active={sort}
          onChange={(next) => navigate(patchHref(pathname, params, { sort: next === DEFAULT_DESK_SORT ? null : next }))}
        />
      </Toolbar>

      {visible.length === 0 ? (
        <p className="text-muted-foreground">No fund matches these filters.</p>
      ) : view === "sectors" ? (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="w-full min-w-[44rem] border-collapse font-mono text-sm">
              <caption className="sr-only">Fund weights by sector, percent of each fund</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="w-8 px-1 py-2 font-normal">
                    <span className="sr-only">{EXPANDER_HEADER}</span>
                  </th>
                  <th scope="col" className="px-2 py-2 font-normal">
                    <span className="sr-only">Compare</span>
                  </th>
                  <th scope="col" className="px-2 py-2 font-normal">Fund (ticker · manager)</th>
                  {columns.map((sector) => (
                    <th key={sector} scope="col" className="px-2 py-2 font-normal">
                      <span className="flex items-center gap-1.5">
                        <SectorIcon industry={sector} size={16} />
                        <span className="max-w-[9rem] truncate" title={sector}>
                          {shortSector(sector)}
                        </span>
                      </span>
                    </th>
                  ))}
                  <th scope="col" className="px-2 py-2 text-right font-normal">Other</th>
                  <th scope="col" className="px-2 py-2 text-right font-normal">As at</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((fund) => {
                  const checked = selected.includes(fund.key);
                  const current = sel === `fund:${fund.key}`;
                  const change = sort === "changed" ? sectorChangeDetail(fund) : "";
                  return (
                    <ExpandableRow
                      key={fund.key}
                      id={`fund-${fund.key}-detail`}
                      label={`${fundLabel(fund)} sector weights and largest positions`}
                      colSpan={5 + columns.length}
                      current={current}
                      className={cn(FUND_ROW_CLASS, current && "bg-muted/40 outline outline-1 -outline-offset-1 outline-primary")}
                      detail={
                        <div className="grid gap-6 md:grid-cols-2">
                        <FigureList
                          rows={[
                            ...fund.sectorWeights.map((row) => ({
                              label: industryLabel(row.industry) || NOT_AVAILABLE,
                              value: formatWeight(row.weightPct, 1),
                            })),
                            { label: "Top 10 holdings", value: formatPct(fund.top10Pct, { digits: 1 }) },
                          ]}
                        />
                        <FigureList
                          rows={fund.largest.map((holding) => ({
                            label: `${holding.code} ${holding.name}`,
                            value: formatWeight(holding.weightPct, 1),
                          }))}
                        />
                      </div>
                      }
                    >
                      <td className="px-2 py-2">
                        <input
                          type="checkbox"
                          aria-label={`Compare ${fundLabel(fund)}`}
                          checked={checked}
                          disabled={!checked && full}
                          onChange={() => setSelected(toggleFundKey(selected, fund.key))}
                          className="h-4 w-4 accent-[hsl(var(--primary))]"
                        />
                      </td>
                      <td className="px-2 py-2">
                        {/*
                          One line: the logo box (fixed at 20 px, so it never shifts), the ticker, the ETF or
                          Pooled tag, then the manager, which truncates with its full name in the title.
                        */}
                        <Link
                          href={patchHref(pathname, params, { sel: `fund:${fund.key}` })}
                          scroll={false}
                          prefetch={false}
                          className="flex min-w-0 items-center gap-2 whitespace-nowrap rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <HolderLogo name={fund.institutionName} kind="" holderKey={fund.institutionSlug} size={20} />
                          <span className="shrink-0 font-semibold text-foreground">{fundLabel(fund)}</span>
                          <span className="shrink-0 rounded-[var(--radius)] border border-border px-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                            {fundKindLabel(fund)}
                          </span>
                          <span className="min-w-0 max-w-[10rem] truncate text-xs text-muted-foreground" title={fund.institutionName}>
                            {fund.institutionName}
                          </span>
                          {change !== "" ? <span className="shrink-0 text-xs text-muted-foreground">{change}</span> : null}
                        </Link>
                      </td>
                      {columns.map((sector) => {
                        const weight = sectorWeightOf(fund, sector);
                        return (
                          <td
                            key={sector}
                            className="px-2 py-2 text-right tabular-nums"
                            style={{
                              background: lensFill(weight, WEIGHT_SCALE) ?? undefined,
                              color: weight === null ? undefined : labelOnBin(binOf(weight, WEIGHT_SCALE), WEIGHT_SCALE),
                            }}
                          >
                            {formatWeight(weight, 1)}
                          </td>
                        );
                      })}
                      <td className="px-2 py-2 text-right tabular-nums">{formatWeight(otherWeightOf(fund, columns), 1)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-right tabular-nums text-muted-foreground">{fund.asAt || "n/a"}</td>
                    </ExpandableRow>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-mono text-xs text-muted-foreground">
            <p>{LEGEND_COPY}</p>
            <div className="flex items-center gap-2" aria-hidden="true">
              <span>0%</span>
              <span className="flex">
                {LEGEND_BINS.map((bin) => (
                  <span key={bin} className="h-3 w-6 border border-border" style={{ background: binFill(bin, WEIGHT_SCALE) }} />
                ))}
              </span>
              <span>≥ 40%</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full min-w-[32rem] border-collapse font-mono text-sm">
            <caption className="sr-only">Each fund&apos;s ten largest reported positions</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="w-8 px-1 py-2 font-normal"><span className="sr-only">{EXPANDER_HEADER}</span></th>
                <th scope="col" className="px-2 py-2 font-normal">Fund</th>
                <th scope="col" className="px-2 py-2 font-normal">Holding</th>
                <th scope="col" className="px-2 py-2 text-right font-normal">Weight</th>
              </tr>
            </thead>
            <tbody>
              {visible.flatMap((fund) =>
                fund.largest.map((holding) => (
                  <ExpandableRow
                    key={`${fund.key}:${holding.code}`}
                    id={`holding-${fund.key}-${holding.code}`}
                    label={`${holding.code} in ${fundLabel(fund)} details`}
                    colSpan={4}
                    detail={
                      <FigureList
                        rows={[
                          { label: "Weight in this fund", value: formatWeight(holding.weightPct, 2) },
                          { label: "Fund", value: `${fundLabel(fund)} · ${fund.institutionName}` },
                          { label: "Holdings as at", value: fund.asAt || NOT_AVAILABLE },
                        ]}
                      />
                    }
                  >
                    <td className="px-2 py-2">{fundLabel(fund)}</td>
                    <td className="px-2 py-2">
                      <span className="flex items-center gap-2">
                        <StockLogoBox code={holding.code} size={20} />
                        <Link
                          href={patchHref(pathname, params, { sel: `holding:${fund.key}/${holding.code}` })}
                          scroll={false}
                          prefetch={false}
                          className="underline underline-offset-4"
                        >
                          {holding.code}
                        </Link>{" "}
                        <span className="text-muted-foreground">{holding.name}</span>
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right tabular-nums">{formatWeight(holding.weightPct, 1)}</td>
                  </ExpandableRow>
                )),
              )}
            </tbody>
          </table>
        </div>
      )}

      {selected.length > 0 ? (
        <div
          role="region"
          aria-label="Selected funds"
          className="sticky bottom-4 flex flex-wrap items-center gap-3 rounded-md border border-border bg-card px-4 py-3 font-mono text-sm"
        >
          <p>
            {selected.length} {selected.length === 1 ? "fund" : "funds"} selected
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {selected.map((key) => (
              <li key={key}>
                <button
                  type="button"
                  aria-label={`Remove ${tickerOf(key)}`}
                  onClick={() => setSelected(selected.filter((k) => k !== key))}
                  className="rounded-[var(--radius)] border border-border px-2 py-0.5 text-xs hover:border-primary"
                >
                  {tickerOf(key)} ×
                </button>
              </li>
            ))}
          </ul>
          {selected.length > 1 ? (
            <p className="text-xs text-muted-foreground">The comparison reads one fund: {tickerOf(selected[0] ?? "")}.</p>
          ) : null}
          <Link
            href={`/ownership/changes?fund=${encodeURIComponent(selected[0] ?? "")}`}
            prefetch={false}
            className="ml-auto text-primary underline underline-offset-4"
          >
            Compare portfolios →
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** The fund exposure map, reading its state from the URL under its own boundary. */
export const FundExposureMap = withUrlState(FundExposureMapView);
