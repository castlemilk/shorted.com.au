import type { ReactNode } from "react";
import Link from "next/link";
import { SelectionTray } from "~/@/components/workspace/selection-tray";
import { Toolbar } from "~/@/components/workspace/toolbar";
import { WorkspacePage } from "~/@/components/workspace/workspace-page";
import { ViewDisclosure } from "~/@/components/ownership/workspace/view-disclosure";
import { buttonVariants } from "~/@/components/ui/button";
import { cn } from "~/@/lib/utils";
import {
  COMPARE_LIMIT,
  COMPARE_MINIMUM,
  EVIDENCE_OPTIONS,
  UNIVERSE_OPTIONS,
  WINDOW_OPTIONS,
  compareHref,
  filterRows,
  type ExplorerFilters,
  type ExplorerModel,
  type ExplorerOption,
  type ExplorerRow,
  type WindowId,
} from "~/@/lib/strategies/explorer";
import { ReturnsHeatmapTable, ReturnsLegend, type ReturnsHeatmapRow } from "./returns-heatmap-table";
import { StrategyInspector } from "./strategy-inspector";

/** The handlers an island passes; the static render has none, and draws every control inert. */
export interface ExplorerControls {
  onFilters: (patch: Partial<ExplorerFilters>) => void;
  onWindow: (id: WindowId) => void;
  onSelect: (id: string) => void;
  onToggle: (id: string) => void;
}

export interface ExplorerViewProps {
  model: ExplorerModel;
  /** The page's heading and lede, drawn above the toolbar. */
  header: ReactNode;
  filters: ExplorerFilters;
  windowId: WindowId;
  selectedId: string | null;
  picked: readonly string[];
  /** true, false, or undefined while the session is still being read. */
  signedIn?: boolean;
  /** Whether the compare capability is on (capabilities.ts): the checkboxes, the tray and its CTA follow it. */
  compareEnabled: boolean;
  controls?: ExplorerControls;
  /** The rail as a bottom sheet below lg, drawn by the island. */
  sheet?: ReactNode;
}

/** The sign-in page returns to the comparison the visitor was building. */
function signInHref(ids: readonly string[]): string {
  return `/signin?callbackUrl=${encodeURIComponent(compareHref(ids))}`;
}

/**
 * A toolbar select with its label inside it, as the mockup reads: "Style: All". The label is
 * the control's accessible name (aria-label), and each option reads with the same prefix.
 */
function InlineSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly ExplorerOption[];
  onChange?: (value: string) => void;
}) {
  return (
    <select
      aria-label={label}
      value={value}
      disabled={!onChange}
      onChange={(event) => onChange?.(event.target.value)}
      className="h-8 min-w-0 max-w-[9rem] rounded-sm border border-input bg-background px-2 font-mono text-xs text-foreground disabled:cursor-default"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {label}: {o.label}
        </option>
      ))}
    </select>
  );
}

function SearchField({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
  return (
    <input
      type="search"
      aria-label="Find a strategy"
      value={value}
      disabled={!onChange}
      onChange={(event) => onChange?.(event.target.value)}
      placeholder="Find a strategy…"
      className="h-8 min-w-0 w-full rounded-sm border border-input bg-background px-2 font-mono text-xs text-foreground placeholder:text-muted-foreground sm:w-48"
    />
  );
}

/**
 * The explorer, as one pure view: the header, the toolbar in one row (search, Style, Horizon,
 * Universe, Evidence; folded under "Adjust view" below sm), the "Historical returns by year"
 * table with its Window select, the legend and footer, the compare tray and the rail. It holds
 * no state and reads no URL. The island renders it with the URL's state and handlers; the page
 * renders it with the defaults as the Suspense fallback, so the static HTML carries the table.
 */
export function ExplorerView({
  model,
  header,
  filters,
  windowId,
  selectedId,
  picked,
  signedIn,
  compareEnabled,
  controls,
  sheet,
}: ExplorerViewProps) {
  const rows = filterRows(model.rows, filters);
  const selected = model.rows.find((row) => row.id === selectedId) ?? null;
  const pickedRows = picked
    .map((id) => model.rows.find((row) => row.id === id))
    .filter((row): row is ExplorerRow => row !== undefined);
  const full = picked.length >= COMPARE_LIMIT;
  const isLive = windowId === "live";

  const heatmapRows: ReturnsHeatmapRow[] = rows.map((row) => {
    const isPicked = picked.includes(row.id);
    const isSelected = row.id === selectedId;
    return {
      key: row.id,
      name: controls ? (
        <button
          type="button"
          onClick={() => controls.onSelect(row.id)}
          aria-pressed={isSelected}
          className={cn("rounded-sm text-left underline-offset-2 hover:underline", isSelected && "font-semibold")}
        >
          {row.name}
        </button>
      ) : (
        row.name
      ),
      sublabel: row.sublabel,
      cells: row.cells,
      metrics: [...row.metricsByWindow[windowId], row.live],
      selected: isSelected,
      lead: compareEnabled ? (
        <input
          type="checkbox"
          checked={isPicked}
          disabled={!controls || (full && !isPicked)}
          onChange={() => controls?.onToggle(row.id)}
          aria-label={`Compare ${row.name}`}
          className="h-4 w-4 accent-[hsl(var(--primary))]"
        />
      ) : null,
    };
  });

  const inspector = selected ? (
    <StrategyInspector id={selected.id} inspector={selected.inspector} benchmarkName={model.benchmarkName} />
  ) : (
    <p className="text-sm text-muted-foreground">Select a strategy to see its evidence.</p>
  );

  const cta = (() => {
    if (pickedRows.length < COMPARE_MINIMUM) {
      return <span className="text-muted-foreground">Select one more to compare</span>;
    }
    // While the session loads the button is neutral: it names the comparison but says
    // nothing about sign-in yet.
    if (signedIn === undefined) {
      return (
        <span aria-disabled="true" className={cn(buttonVariants({ variant: "outline" }), "pointer-events-none opacity-60")}>
          Compare strategies →
        </span>
      );
    }
    if (signedIn === false) {
      return (
        <Link href={signInHref(picked)} prefetch={false} className={buttonVariants({ variant: "default" })}>
          Sign in to compare
        </Link>
      );
    }
    return (
      <Link href={compareHref(picked)} prefetch={false} className={buttonVariants({ variant: "default" })}>
        Compare strategies →
      </Link>
    );
  })();

  const universeOptions: ExplorerOption[] = UNIVERSE_OPTIONS.map((o) => ({ value: o.value, label: o.label }));

  return (
    <WorkspacePage inspector={<div className="hidden lg:block">{inspector}</div>}>
      {header}

      <div className="mt-6 space-y-4">
        <Toolbar fold={(row) => <ViewDisclosure>{row}</ViewDisclosure>}>
          <SearchField value={filters.query} onChange={controls ? (query) => controls.onFilters({ query }) : undefined} />
          <InlineSelect
            label="Style"
            value={filters.style}
            options={model.styles}
            onChange={controls ? (style) => controls.onFilters({ style }) : undefined}
          />
          <InlineSelect
            label="Horizon"
            value={filters.horizon}
            options={model.horizons}
            onChange={controls ? (horizon) => controls.onFilters({ horizon }) : undefined}
          />
          <InlineSelect
            label="Universe"
            value={filters.universe}
            options={universeOptions}
            onChange={controls ? (universe) => controls.onFilters({ universe: universe as ExplorerFilters["universe"] }) : undefined}
          />
          <InlineSelect
            label="Evidence"
            value={filters.evidence}
            options={EVIDENCE_OPTIONS}
            onChange={controls ? (evidence) => controls.onFilters({ evidence: evidence as ExplorerFilters["evidence"] }) : undefined}
          />
        </Toolbar>

        <section aria-labelledby="returns-heading" className="rounded-lg border border-border/60 bg-card p-3 sm:p-4">
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="returns-heading" className="font-serif text-xl font-semibold tracking-tight">
              Historical returns by year
            </h2>
            <span className="rounded-sm border border-solid border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {model.chipLabel}
            </span>
            <div className="ml-auto">
              <InlineSelect
                label="Window"
                value={windowId}
                options={WINDOW_OPTIONS.map((w) => ({ value: w.id, label: w.label }))}
                onChange={controls ? (value) => controls.onWindow(value as WindowId) : undefined}
              />
            </div>
          </div>

          <div className="mt-4">
            {model.evidenceAvailable ? null : (
              <p className="mb-3 text-sm text-muted-foreground">
                Backtest evidence is temporarily unavailable. The figures return when it does.
              </p>
            )}
            <ReturnsHeatmapTable
              caption="Each strategy's calendar-year return, with the selected window's figures beside it"
              rowHeader="Strategy"
              scale="annual"
              columns={model.columns}
              rows={heatmapRows}
              metricColumns={[
                { key: "cagr", label: isLive ? "Return" : "CAGR" },
                { key: "maxdd", label: "Max DD" },
                { key: "live", label: "Live" },
              ]}
              leading={compareEnabled ? { header: "Compare" } : undefined}
            />
            {rows.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No strategy matches these filters.</p>
            ) : null}
          </div>

          <div className="mt-5 space-y-3 border-t border-border/60 pt-4 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <span className="font-mono">Colour scale: annual return, total return after costs</span>
              <ReturnsLegend scale="annual" />
            </div>
            <ul className="space-y-1">
              <li>
                <span className="font-mono">cov</span>: share of the names this strategy could have held that have prices (qualifying ≥ 5% short); hatched under 80%; low coverage flatters results, by how much cannot be measured.
              </li>
              <li>
                <span className="font-mono">?</span> Measured on ASIC-reported names only; delisted companies that were never shorted are missing and cannot be counted.
              </li>
            </ul>
            {model.rangeLine ? <p className="font-mono">{model.rangeLine}</p> : null}
            {model.footnotes.length > 0 ? (
              <ul className="space-y-1 italic">
                {model.footnotes.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </section>

        {compareEnabled ? (
          <SelectionTray
            label="Strategies to compare"
            items={pickedRows.map((row) => ({ key: row.id, label: row.name }))}
            max={COMPARE_LIMIT}
            noun={["strategy", "strategies"]}
            onRemove={(id) => controls?.onToggle(id)}
            cta={<div className="ml-auto">{cta}</div>}
          />
        ) : null}
      </div>
      {sheet}
    </WorkspacePage>
  );
}
