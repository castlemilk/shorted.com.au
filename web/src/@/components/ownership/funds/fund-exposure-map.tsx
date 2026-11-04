"use client";

import Link from "next/link";
import { useState } from "react";
import { SegmentedControl } from "~/@/components/gamma/SegmentedControl";
import { cn } from "@/lib/utils";
import { sectionTitle } from "@/lib/typography";
import { NOT_AVAILABLE, formatPct } from "~/@/lib/fundamentals/format";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { binFill, binOf, labelOnBin, lensFill, type LensScale } from "../desk/desk-scales";
import { HolderLogo } from "../workspace/holder-logo";
import { Toolbar } from "../workspace/toolbar";
import { ViewDisclosure } from "../workspace/view-disclosure";
import { SectorIcon } from "../workspace/sector-icon";
import { StockLogoBox } from "../workspace/stock-logo-box";
import { FigureList } from "./row-disclosure";
import { EXPANDER_HEADER, ExpandableRow } from "./expandable-row";
import { shortSector } from "~/@/lib/ownership/kinds";
import { withUrlState, type UrlState } from "./url-params";
import {
  FUND_COMPARE_MAX,
  fundKindLabel,
  formatWeight,
  otherWeightOf,
  parseFundKeys,
  patchHref,
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

const TYPE_OPTIONS = [
  { value: "index", label: "Index funds" },
  { value: "super", label: "Super options" },
] as const;
const VIEW_OPTIONS = [
  { value: "sectors", label: "Sector weights" },
  { value: "holdings", label: "Holdings" },
] as const;
const COVERAGE_OPTIONS = [
  { value: "files", label: "Files available" },
  { value: "all", label: "All tracked" },
] as const;

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
  const byType = funds.filter((fund) => (type === "super" ? fund.sourceKind === "super_phd" : fund.sourceKind !== "super_phd"));
  const managers = [...new Set(byType.map((fund) => fund.institutionName).filter((name) => name !== ""))].sort();
  const visible = byType.filter(
    (fund) =>
      fundMatches(fund, query) &&
      (manager === "" || fund.institutionName === manager) &&
      (coverage === "all" || fundHasFile(fund)),
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

      {/* One toolbar row (spec 14.9): the search, the labelled filters and the table view, under "Adjust view" below sm. */}
      <Toolbar fold={(row) => <ViewDisclosure>{row}</ViewDisclosure>}>
        <label className="flex min-w-[14rem] flex-1 flex-col gap-1 font-mono text-xs text-muted-foreground">
          Search fund, code or manager
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="A200, Vanguard, Betashares"
            className="h-10 rounded-md border border-input bg-background px-3 font-mono text-sm text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
          Manager
          <select
            aria-label="Manager"
            value={manager}
            onChange={(event) => navigate(patchHref(pathname, params, { manager: event.target.value || null }))}
            className="h-10 min-w-[11rem] rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
          >
            <option value="">All managers</option>
            {managers.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <SegmentedControl
          label="Fund type"
          options={TYPE_OPTIONS.map((option) => ({ ...option }))}
          value={type}
          onChange={(value) => navigate(patchHref(pathname, params, { type: value === "index" ? null : value }))}
        />
        <SegmentedControl
          label="Table view"
          options={VIEW_OPTIONS.map((option) => ({ ...option }))}
          value={view}
          onChange={(value) => navigate(patchHref(pathname, params, { view: value === "sectors" ? null : value }))}
        />
        <SegmentedControl
          label="Coverage"
          options={COVERAGE_OPTIONS.map((option) => ({ ...option }))}
          value={coverage}
          onChange={(value) => navigate(patchHref(pathname, params, { coverage: value === "files" ? null : value }))}
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
                  return (
                    <ExpandableRow
                      key={fund.key}
                      id={`fund-${fund.key}-detail`}
                      label={`${fundLabel(fund)} sector weights and largest positions`}
                      colSpan={5 + columns.length}
                      current={current}
                      className={cn(current && "bg-muted/40 outline outline-1 -outline-offset-1 outline-primary")}
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
                        <Link
                          href={patchHref(pathname, params, { sel: `fund:${fund.key}` })}
                          scroll={false}
                          prefetch={false}
                          className="flex flex-col rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          <span className="flex items-center gap-2">
                            <span className="font-semibold">{fundLabel(fund)}</span>
                            <span className="rounded-[var(--radius)] border border-border px-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                              {fundKindLabel(fund)}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                            <HolderLogo name={fund.institutionName} kind="" holderKey={fund.institutionSlug} size={20} />
                            {fund.institutionName}
                          </span>
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
