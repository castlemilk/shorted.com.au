import type { ReactNode } from "react";
import Link from "next/link";
import { SelectionTray } from "~/@/components/workspace/selection-tray";
import { Toolbar, ToolbarSelect } from "~/@/components/workspace/toolbar";
import { WorkspacePage } from "~/@/components/workspace/workspace-page";
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
  /** The page's own heading and lede, drawn above the toolbar. */
  header: ReactNode;
  filters: ExplorerFilters;
  windowId: WindowId;
  selectedId: string | null;
  picked: readonly string[];
  /** true, false, or undefined while the session is still being read. */
  signedIn?: boolean;
  controls?: ExplorerControls;
  /** The rail as a bottom sheet below lg, drawn by the island. */
  sheet?: ReactNode;
}

const FIELD = "h-8 min-w-0 w-full rounded-sm border border-input bg-background px-2 font-mono text-xs text-foreground sm:w-56";

/** The sign-in page returns to the comparison the visitor was building. */
function signInHref(ids: readonly string[]): string {
  return `/signin?callbackUrl=${encodeURIComponent(compareHref(ids))}`;
}

function SearchField({ value, onChange }: { value: string; onChange?: (value: string) => void }) {
  return (
    <label className="flex w-full items-center gap-2 sm:w-72">
      <span className="sr-only">Find a strategy</span>
      <input
        type="search"
        value={value}
        disabled={!onChange}
        onChange={(event) => onChange?.(event.target.value)}
        placeholder="Find a strategy…"
        className={cn(FIELD, "sm:w-72 placeholder:text-muted-foreground")}
      />
    </label>
  );
}

/**
 * The explorer, as one pure view: the header, the toolbar (search, Style, Horizon,
 * Universe, Evidence), the "Historical returns by year" table with its Window select,
 * the legend and footer, the selection tray and the rail. It holds no state and reads
 * no URL. The island renders it with the URL's state and handlers; the page renders it
 * with the defaults as the Suspense fallback, so the static HTML carries the same table.
 */
export function ExplorerView({
  model,
  header,
  filters,
  windowId,
  selectedId,
  picked,
  signedIn,
  controls,
  sheet,
}: ExplorerViewProps) {
  const rows = filterRows(model.rows, filters);
  const selected = model.rows.find((row) => row.id === selectedId) ?? null;
  const pickedRows = picked
    .map((id) => model.rows.find((row) => row.id === id))
    .filter((row): row is ExplorerRow => row !== undefined);
  const full = picked.length >= COMPARE_LIMIT;

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
          className={cn(
            "rounded-sm text-left hover:underline underline-offset-2",
            isSelected && "font-semibold",
          )}
        >
          {row.name}
        </button>
      ) : (
        row.name
      ),
      sublabel: row.sublabel,
      cells: row.cells,
      metrics: [...row.metricsByWindow[windowId], row.live],
      lead: (
        <input
          type="checkbox"
          checked={isPicked}
          disabled={!controls || (full && !isPicked)}
          onChange={() => controls?.onToggle(row.id)}
          aria-label={`Compare ${row.name}`}
          className="h-4 w-4 accent-[hsl(var(--primary))]"
        />
      ),
    };
  });

  const inspector = selected ? (
    <StrategyInspector id={selected.id} inspector={selected.inspector} benchmarkName={model.benchmarkName} />
  ) : (
    <p className="text-sm text-muted-foreground">Select a strategy to see its evidence.</p>
  );

  const cta =
    pickedRows.length >= COMPARE_MINIMUM ? (
      signedIn === false ? (
        <Link
          href={signInHref(picked)}
          prefetch={false}
          className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
        >
          Sign in to compare
        </Link>
      ) : (
        <Link
          href={compareHref(picked)}
          prefetch={false}
          className="font-medium text-foreground underline underline-offset-2 hover:no-underline"
        >
          Compare strategies →
        </Link>
      )
    ) : (
      <span className="text-muted-foreground">Select one more to compare</span>
    );

  return (
    <WorkspacePage inspector={<div className="hidden lg:block">{inspector}</div>}>
      {header}

      <div className="mt-6 space-y-4">
        <Toolbar>
          <SearchField
            value={filters.query}
            onChange={controls ? (query) => controls.onFilters({ query }) : undefined}
          />
          <ToolbarSelect
            label="Style"
            value={filters.style}
            onChange={controls ? (style) => controls.onFilters({ style }) : undefined}
          >
            {model.styles.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value === "all" ? "All" : o.label}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            label="Horizon"
            value={filters.horizon}
            onChange={controls ? (horizon) => controls.onFilters({ horizon }) : undefined}
          >
            {model.horizons.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value === "all" ? "All" : o.label}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            label="Universe"
            value={filters.universe}
            onChange={controls ? (universe) => controls.onFilters({ universe: universe as ExplorerFilters["universe"] }) : undefined}
          >
            {UNIVERSE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </ToolbarSelect>
          <ToolbarSelect
            label="Evidence"
            value={filters.evidence}
            onChange={controls ? (evidence) => controls.onFilters({ evidence: evidence as ExplorerFilters["evidence"] }) : undefined}
          >
            {EVIDENCE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </ToolbarSelect>
        </Toolbar>

        <section
          aria-labelledby="returns-heading"
          className="rounded-lg border border-border/60 bg-card p-4 sm:p-5"
        >
          <div className="flex flex-wrap items-center gap-3">
            <h2 id="returns-heading" className="font-serif text-xl font-semibold tracking-tight">
              Historical returns by year
            </h2>
            <span className="rounded-sm border border-dashed border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
              {model.chipLabel}
            </span>
            <div className="ml-auto">
              <ToolbarSelect
                label="Window"
                value={windowId}
                onChange={controls ? (value) => controls.onWindow(value as WindowId) : undefined}
              >
                {WINDOW_OPTIONS.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.label}
                  </option>
                ))}
              </ToolbarSelect>
            </div>
          </div>

          <div className="mt-4">
            {model.evidenceAvailable ? null : (
              <p className="mb-3 text-sm text-muted-foreground">
                Backtest evidence is temporarily unavailable. The figures return when it does.
              </p>
            )}
            <ReturnsHeatmapTable
              caption="Annual return by calendar year, total return after costs, with the selected window's CAGR and maximum drawdown"
              rowHeader="Strategy"
              scale="annual"
              columns={model.columns}
              rows={heatmapRows}
              metricColumns={[
                { key: "cagr", label: "CAGR" },
                { key: "maxdd", label: "Max DD" },
                { key: "live", label: "Live" },
              ]}
              leading={{ header: "Compare" }}
            />
            {rows.length === 0 ? (
              <p className="mt-3 text-sm text-muted-foreground">No strategy matches these filters.</p>
            ) : null}
          </div>

          <div className="mt-5 space-y-3 border-t border-border/60 pt-4 text-xs text-muted-foreground">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <p className="font-mono">Annual return, total return after costs</p>
              <ReturnsLegend scale="annual" />
            </div>
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

        <SelectionTray
          label="Strategies to compare"
          items={pickedRows.map((row) => ({ key: row.id, label: row.name }))}
          max={COMPARE_LIMIT}
          noun={["strategy", "strategies"]}
          onRemove={(id) => controls?.onToggle(id)}
          cta={cta}
        />
      </div>
      {sheet}
    </WorkspacePage>
  );
}
