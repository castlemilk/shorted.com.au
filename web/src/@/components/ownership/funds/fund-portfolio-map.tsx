"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SearchCombobox } from "~/@/components/gamma/SearchCombobox";
import { SegmentedControl } from "~/@/components/gamma/SegmentedControl";
import { cn } from "@/lib/utils";
import { sectionTitle } from "@/lib/typography";
import { parseSelection } from "../workspace/selection";
import { SectorIcon } from "../workspace/sector-icon";
import { StockLogoBox } from "../workspace/stock-logo-box";
import { FundHoldingsList } from "./fund-holdings-list";
import { withUrlState, type UrlState } from "./url-params";
import {
  boxPercent,
  cleanIsoDate,
  formatWeight,
  holdingsTreemap,
  patchHref,
  sectorSummary,
  sectorTint,
  sectorWeightTotals,
  type FundPortfolio,
  type LoadFundPortfolio,
} from "./fund-model";

/** The canvas the treemap is laid out on; cells are placed as percentages of it, so it resizes with the page. */
export const TREEMAP_WIDTH = 1000;
export const TREEMAP_HEIGHT = 560;
/** A cell carries its company's logo from this size, in rendered pixels: 72 x 48 (spec 14.2). */
export const CELL_LOGO_MIN = { width: 72, height: 48 } as const;

/**
 * Whether a cell is large enough for its logo at the width the map is drawn: the
 * cell's canvas extent scaled to the rendered width, so 72 x 48 is pixels on screen
 * (spec 14.2), not canvas units.
 */
export function logoFits(cell: { x0: number; x1: number; y0: number; y1: number }, mapWidth: number): boolean {
  const scale = mapWidth / TREEMAP_WIDTH;
  return (cell.x1 - cell.x0) * scale >= CELL_LOGO_MIN.width && (cell.y1 - cell.y0) * scale >= CELL_LOGO_MIN.height;
}

export interface FundPortfolioMapProps {
  portfolio: FundPortfolio;
  loadPortfolio: LoadFundPortfolio;
}

/**
 * The portfolio map (spec 14.3, Fund page): the holdings as a treemap grouped by
 * sector, area the weight, each sector in its own tint; or the same holdings as a
 * table. The snapshot is `?as=` (the file dates), the view `?view=`, a zoomed sector
 * `?focus=` (set by a sector's header), the selected holding `?sel=holding:FUND/CODE`.
 * Choosing a snapshot reads that file. A selected holding's weight across the files
 * is drawn by the inspector, not here, so one selection reads the files once.
 */
export function FundPortfolioMapView({
  portfolio,
  loadPortfolio,
  params,
  pathname,
  navigate,
}: FundPortfolioMapProps & UrlState) {
  const asParam = cleanIsoDate(params.get("as"));
  const view = params.get("view") === "holdings" ? "holdings" : "treemap";
  const focus = params.get("focus") ?? "";
  const selection = parseSelection(params.get("sel") ?? "");
  const selectedCode =
    selection?.kind === "holding" && selection.fundKey === portfolio.key ? selection.code : null;
  const shell = useRef<HTMLElement>(null);
  // The treemap's rendered width, measured: a cell's logo is judged in pixels, not canvas units.
  const [mapWidth, setMapWidth] = useState<number>(TREEMAP_WIDTH);
  const observer = useRef<ResizeObserver | null>(null);
  const mapRef = useCallback((node: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (node === null || typeof ResizeObserver === "undefined") return;
    const measure = () => setMapWidth(node.clientWidth || TREEMAP_WIDTH);
    observer.current = new ResizeObserver(measure);
    observer.current.observe(node);
    measure();
  }, []);

  // The snapshot read: the page's own file is the default, any other is read on demand.
  const want = asParam !== "" && asParam !== portfolio.asAt ? asParam : "";
  const [loaded, setLoaded] = useState<{ asAt: string; fund: FundPortfolio } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (want === "") return;
    let live = true;
    void loadPortfolio({ fundKey: portfolio.key, asAt: want }).then((page) => {
      if (!live) return;
      if (page.ok && page.fund) {
        setLoaded({ asAt: want, fund: page.fund });
        setFailed(false);
      } else {
        setFailed(true);
      }
    });
    return () => {
      live = false;
    };
  }, [want, portfolio.key, loadPortfolio]);
  const current = want === "" ? portfolio : loaded !== null && loaded.asAt === want ? loaded.fund : null;

  const layout = current ? holdingsTreemap(current.holdings, TREEMAP_WIDTH, TREEMAP_HEIGHT, focus) : null;
  // A sector's tint is its place in the whole file's layout, never in the zoomed one, so a
  // sector keeps its colour when it is focused and when another file is shown.
  const sectorOrder = useMemo(
    () =>
      current ? holdingsTreemap(current.holdings, TREEMAP_WIDTH, TREEMAP_HEIGHT, "").sectors.map((s) => s.sector) : [],
    [current],
  );
  const totals = current ? sectorWeightTotals(current.holdings) : new Map<string, number>();
  const selectOptions = [...portfolio.snapshotDates].reverse();
  const hrefFor = (patch: Record<string, string | null>) => patchHref(pathname, params, patch);
  const fullScreen = () => {
    if (typeof document !== "undefined" && document.fullscreenEnabled) {
      void shell.current?.requestFullscreen?.();
    }
  };

  return (
    <section ref={shell} aria-label="Portfolio map" className="space-y-4 bg-background">
      <div className="flex flex-wrap items-end gap-3">
        <h2 className={cn(sectionTitle, "w-full")}>Portfolio map</h2>
        <div className="min-w-[14rem] flex-1">
          <SearchCombobox
            label="Find a holding"
            options={portfolio.holdings.map((holding) => ({
              value: holding.code,
              label: `${holding.code} ${holding.name}`,
            }))}
            value={selectedCode}
            onValueChange={(value) =>
              navigate(hrefFor({ sel: value ? `holding:${portfolio.key}/${value}` : null }))
            }
          />
        </div>
        <label className="flex flex-col gap-1 font-mono text-xs text-muted-foreground">
          Snapshot
          <select
            aria-label="Snapshot"
            value={want || portfolio.asAt}
            onChange={(event) => navigate(hrefFor({ as: event.target.value === portfolio.asAt ? null : event.target.value }))}
            className="h-10 rounded-md border border-input bg-background px-2 font-mono text-sm text-foreground"
          >
            {selectOptions.map((date) => (
              <option key={date} value={date}>
                {date}
              </option>
            ))}
          </select>
        </label>
        <SegmentedControl
          label="Map view"
          options={[
            { value: "treemap", label: "Treemap" },
            { value: "holdings", label: "Holdings" },
          ]}
          value={view}
          onChange={(value) => navigate(hrefFor({ view: value === "treemap" ? null : value }))}
        />
        <button
          type="button"
          onClick={fullScreen}
          className="h-10 rounded-md border border-border px-3 font-mono text-sm hover:border-primary"
        >
          Full screen
        </button>
      </div>

      {selectedCode !== null || focus !== "" ? (
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {selectedCode !== null ? (
            <li>
              <Link
                href={hrefFor({ sel: null })}
                scroll={false}
                prefetch={false}
                aria-label={`${selectedCode} selected, clear`}
                className="inline-flex items-center rounded-[var(--radius)] border border-border px-2 py-1 font-mono hover:border-primary"
              >
                {selectedCode} selected ×
              </Link>
            </li>
          ) : null}
          {focus !== "" ? (
            <li>
              <Link
                href={hrefFor({ focus: null })}
                scroll={false}
                prefetch={false}
                aria-label={`Focus ${focus}, clear`}
                className="inline-flex items-center rounded-[var(--radius)] border border-border px-2 py-1 font-mono hover:border-primary"
              >
                Focus {focus} ×
              </Link>
            </li>
          ) : null}
        </ul>
      ) : null}

      {current === null ? (
        <p role="status" aria-busy={failed ? undefined : true} aria-label={failed ? undefined : "Loading"} className="text-muted-foreground">
          {failed ? "This file could not be read just now." : "Loading…"}
        </p>
      ) : view === "holdings" ? (
        <FundHoldingsList
          holdings={current.holdings}
          selectedCode={selectedCode}
          hrefFor={(code) => hrefFor({ sel: `holding:${portfolio.key}/${code}` })}
        />
      ) : layout !== null && layout.cells.length > 0 ? (
        <div
          ref={mapRef}
          role="group"
          aria-label="Holdings by sector, area is the weight in the fund"
          className="relative w-full overflow-hidden rounded-md border border-border bg-card"
          style={{ aspectRatio: `${TREEMAP_WIDTH} / ${TREEMAP_HEIGHT}` }}
        >
          {layout.sectors.map((sector) => {
            const zoomed = focus === sector.sector;
            return (
              <div
                key={sector.sector}
                className="absolute border border-border/70"
                style={boxPercent(sector, layout.width, layout.height)}
              >
                <Link
                  href={hrefFor({ focus: zoomed ? null : sector.sector })}
                  scroll={false}
                  prefetch={false}
                  aria-current={zoomed ? "true" : undefined}
                  aria-label={`${zoomed ? "Clear focus on" : "Focus"} ${sector.sector}`}
                  className="absolute left-1 top-0.5 flex items-center gap-1 rounded-sm font-mono text-[10px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <SectorIcon industry={sector.sector} size={16} />
                  {sectorSummary(sector.sector, totals.get(sector.sector))}
                </Link>
              </div>
            );
          })}
          {layout.cells.map((cell) => {
            const index = sectorOrder.indexOf(cell.sector);
            const isSelected = selectedCode === cell.code;
            return (
              // A cell selects in place (spec 14.9): a click or Enter writes its sel for the inspector.
              <div
                key={cell.code}
                role="button"
                tabIndex={0}
                data-code={cell.code}
                aria-pressed={isSelected}
                aria-label={`${cell.code} ${cell.name}: ${formatWeight(cell.value)} of the fund`}
                title={`${cell.code} ${cell.name}: ${formatWeight(cell.value)} of the fund`}
                onClick={() => navigate(hrefFor({ sel: `holding:${portfolio.key}/${cell.code}` }))}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    navigate(hrefFor({ sel: `holding:${portfolio.key}/${cell.code}` }));
                  }
                }}
                className={cn(
                  "absolute flex cursor-pointer flex-col justify-end overflow-hidden p-1 font-mono text-[10px] leading-tight focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  isSelected && "z-10 outline outline-2 outline-primary",
                )}
                style={{
                  ...boxPercent(cell, layout.width, layout.height),
                  background: `color-mix(in srgb, ${sectorTint(index)} 30%, hsl(var(--card)))`,
                }}
              >
                {logoFits(cell, mapWidth) ? (
                  <span className="absolute left-1 top-1">
                    <StockLogoBox code={cell.code} size={16} />
                  </span>
                ) : null}
                <span className="truncate font-semibold">{cell.code}</span>
                <span className="tabular-nums">{formatWeight(cell.value, 1)}</span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-muted-foreground">
          {focus !== "" ? `No holdings in ${focus} in this file.` : "No holdings with a stated weight in this file."}
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
        <p>Area: weight in the fund · Colour: sector</p>
        <div className="flex gap-4">
          <Link href={hrefFor({ view: "holdings", sel: null, focus: null })} scroll={false} prefetch={false} className="underline underline-offset-4">
            View all holdings
          </Link>
          <Link href={hrefFor({ view: null, focus: null, sel: null })} scroll={false} prefetch={false} className="underline underline-offset-4">
            Reset view
          </Link>
        </div>
      </div>

    </section>
  );
}

/** The portfolio map, reading its state from the URL under its own boundary. */
export const FundPortfolioMap = withUrlState(FundPortfolioMapView);
