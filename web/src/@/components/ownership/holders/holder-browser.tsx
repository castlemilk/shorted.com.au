"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState, type ReactNode } from "react";
import { SearchCombobox } from "~/@/components/gamma/SearchCombobox";
import { SegmentedControl } from "~/@/components/gamma/SegmentedControl";
import { EmptyState } from "~/@/components/gamma/EmptyState";
import { HolderLogo } from "~/@/components/ownership/workspace/holder-logo";
import { Toolbar } from "~/@/components/ownership/workspace/toolbar";
import { ViewDisclosure } from "~/@/components/ownership/workspace/view-disclosure";
import { kindInfo } from "~/@/lib/ownership/kinds";
import { cn } from "@/lib/utils";
import { sectionTitle } from "@/lib/typography";
import { readDeskState, type DeskSort } from "../desk/desk-state";
import { SortControl, writeSortInPlace } from "../workspace/sort-control";
import {
  HOLDER_CHIPS,
  HOLDER_PARAM,
  filterHolders,
  resolveHolderKey,
  withSearch,
  type DirectoryHolder,
  type HolderRow,
} from "./holder-tree";

/** The directory's first rows: the twenty largest by disclosed positions, until "Show all" (spec 14.9). */
export const DIRECTORY_FIRST = 20;

// The directory row type lives in holder-tree.ts (the loader needs it without a view import); re-exported
// here so the browser's existing importers keep their name.
export type { DirectoryHolder };

/** The positions a holder gained in the window; a row without the count gained none. */
function gainedOf(holder: DirectoryHolder): number {
  return holder.positionsGained ?? 0;
}

/**
 * The kind a `?kind=` value seeds the browser's chip with: the chip's own value when it names one of the
 * chips, else "all". A flow's kind node links here (flowDirectoryHref), so the link lands filtered.
 */
export function chipFromUrl(raw: string | null | undefined): string {
  return HOLDER_CHIPS.find((chip) => chip.value === raw)?.value ?? "all";
}

/**
 * The directory's rows for a chip and a find, in the order the sort gives (backlog C3b). "largest" is
 * the disclosed positions; "changed" is the positions gained in the window, ties by positions. filterHolders
 * keeps each row's object, so the filter goes through it and keeps the count.
 */
function filterDirectory(holders: readonly DirectoryHolder[], chip: string, query: string): DirectoryHolder[] {
  const keep = new Set<HolderRow>(filterHolders(holders, chip, query));
  return holders.filter((holder) => keep.has(holder));
}

/**
 * The rows the directory draws (spec 14.9). A holder with no disclosed position is hidden
 * unless a kind chip is set; a find shows every match; otherwise the twenty first in the sort's
 * order show, and `showAll` draws the rest. Pure, so the list and its tests share it.
 */
export function directoryRows(
  holders: readonly DirectoryHolder[],
  chip: string,
  query: string,
  showAll: boolean,
  sort: DeskSort = "largest",
): { rows: DirectoryHolder[]; total: number } {
  const matches = filterDirectory(holders, chip, query);
  const withPositions = chip === "all" ? matches.filter((holder) => holder.positions > 0) : matches;
  const ranked = [...withPositions].sort((a, b) =>
    sort === "changed"
      ? gainedOf(b) - gainedOf(a) || b.positions - a.positions
      : b.positions - a.positions,
  );
  const open = showAll || query.trim() !== "";
  return { rows: open ? ranked : ranked.slice(0, DIRECTORY_FIRST), total: ranked.length };
}

export interface HolderBrowserProps {
  /** The directory, largest disclosed positions first (the server's read). */
  holders: readonly DirectoryHolder[];
  /** The holder shown when the URL names none. */
  defaultKey: string;
  /** The connections map, drawn in the column beside the list (spec 14.3). */
  children?: ReactNode;
}

/**
 * The holders' browser (spec 14.3): a find box over the directory, the kind chips
 * and the list of holders with their disclosed positions. A row or a find pick
 * writes `?holder=` (the map and the inspector read it), and the selection is
 * cleared, since a company picked for one holder means nothing for the next.
 *
 * The toolbar (find, kind chips, the status line) spans the page above the columns, as the
 * wireframe draws it; the list is the left column and `children` the right one.
 *
 * The URL is read under a Suspense boundary; the fallback is the same list with
 * the default holder, so the static HTML and the first paint agree.
 */
export function HolderBrowser(props: HolderBrowserProps) {
  return (
    <Suspense
      fallback={
        <HolderBrowserView {...props} selectedKey={props.defaultKey} onSelect={noop} sort="largest" initialChip="all">
          {props.children}
        </HolderBrowserView>
      }
    >
      <HolderBrowserBody {...props} />
    </Suspense>
  );
}

const noop = (): void => undefined;

function HolderBrowserBody({ holders, defaultKey, children }: HolderBrowserProps) {
  const pathname = usePathname() ?? "";
  const router = useRouter();
  const params = useSearchParams();
  const search = params?.toString() ?? "";
  const selectedKey = resolveHolderKey(params?.get(HOLDER_PARAM), defaultKey);
  const sort = readDeskState(new URLSearchParams(search)).sort;
  const initialChip = chipFromUrl(params?.get("kind"));
  const onSelect = (key: string) => {
    router.replace(withSearch(pathname, search, { [HOLDER_PARAM]: key, sel: null }), { scroll: false });
  };
  // Keyed by the kind the link names, so a link to the browser that is already open re-seeds its chip.
  return (
    <HolderBrowserView
      key={initialChip}
      holders={holders}
      defaultKey={defaultKey}
      selectedKey={selectedKey}
      onSelect={onSelect}
      sort={sort}
      onSortChange={writeSortInPlace}
      initialChip={initialChip}
    >
      {children}
    </HolderBrowserView>
  );
}

function HolderBrowserView({
  holders,
  selectedKey,
  onSelect,
  sort,
  onSortChange,
  initialChip,
  children,
}: HolderBrowserProps & {
  selectedKey: string;
  onSelect: (key: string) => void;
  /** The sort the directory draws in (backlog C3b). */
  sort: DeskSort;
  /** Absent on the server's default view, where the sort control is drawn disabled. */
  onSortChange?: (next: DeskSort) => void;
  /** The kind chip the browser opens on: the URL's kind, or "all". */
  initialChip: string;
}) {
  const [chip, setChip] = useState(initialChip);
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const directory = useMemo(
    () => directoryRows(holders, chip, query, showAll, sort),
    [holders, chip, query, showAll, sort],
  );
  const visible = directory.rows;
  const changed = sort === "changed";
  const largest = Math.max(1, ...holders.map((h) => h.positions));
  const largestGained = Math.max(1, ...holders.map(gainedOf));
  const options = useMemo(() => holders.map((h) => ({ value: h.key, label: h.name })), [holders]);

  return (
    <div className="min-w-0 space-y-6">
      {/* One toolbar row (spec 14.9): the find and the kind chips, labelled, then the status line in sentence case. */}
      <div className="min-w-0 space-y-2">
        <Toolbar fold={(row) => <ViewDisclosure>{row}</ViewDisclosure>}>
          <div className="min-w-[14rem] flex-1 sm:max-w-xs">
            <SearchCombobox
              options={options}
              placeholder="Find a holder…"
              aria-label="Find a holder"
              label="Find a holder"
              filter
              clearable
              onValueChange={(value) => {
                if (value) onSelect(value);
              }}
              onQueryChange={setQuery}
              className="w-full"
            />
          </div>
          <div className="-mx-1 max-w-full overflow-x-auto px-1">
            <SegmentedControl
              label="Holder kind"
              size="sm"
              value={chip}
              onChange={setChip}
              options={HOLDER_CHIPS.map((c) => ({
                value: c.value,
                label: c.label,
              }))}
            />
          </div>
          <SortControl active={sort} onChange={onSortChange} />
        </Toolbar>
        <p className="text-xs text-muted-foreground">Substantial notices · Latest reported interest per holder</p>
      </div>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
        <section aria-labelledby="holder-browser-heading" className="min-w-0 space-y-4">
          <h2 id="holder-browser-heading" className={sectionTitle}>
            Browse holders
          </h2>
          {visible.length === 0 ? (
            <EmptyState title="No holder matches these filters." />
          ) : (
            <>
            <ul aria-label="Holders" className="divide-y divide-border border-y border-border lg:max-h-[72vh] lg:overflow-y-auto">
              {visible.map((holder) => {
                const active = holder.key === selectedKey;
                const gained = gainedOf(holder);
                const barValue = changed ? gained : holder.positions;
                const barMax = changed ? largestGained : largest;
                return (
                  <li key={holder.key}>
                    <button
                      type="button"
                      aria-pressed={active}
                      aria-current={active ? "true" : undefined}
                      onClick={() => onSelect(holder.key)}
                      className={cn(
                        "flex w-full items-center gap-2 border-l-2 px-3 py-2 text-left text-sm transition-colors hover:bg-muted/40",
                        active ? "border-primary bg-primary/5" : "border-transparent",
                      )}
                    >
                      <HolderLogo
                        name={holder.name}
                        kind={holder.kind}
                        website={holder.website}
                        holderKey={holder.key}
                        size={20}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{holder.name}</span>
                      <span className="shrink-0 font-mono text-xs tabular-nums" title={`${holder.positions} disclosed positions`}>
                        {changed ? (
                          `${gained} gained`
                        ) : (
                          <>
                            {holder.positions}
                            <span className="sr-only"> disclosed positions</span>
                          </>
                        )}
                      </span>
                      <span
                        aria-hidden="true"
                        className="hidden h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-muted sm:block"
                      >
                        {/* The ramp's fourth stop (desk-scales, spec 13.1), so the one legend teaches every bar. */}
                        <span
                          className="block h-full rounded-full"
                          style={{
                            width: `${Math.round((barValue / barMax) * 1000) / 10}%`,
                            background: "hsl(var(--desk-bin-3))",
                          }}
                        />
                      </span>
                      <span
                        aria-hidden="true"
                        title={kindInfo(holder.kind).label}
                        className={cn("h-2 w-2 shrink-0 rounded-full", kindInfo(holder.kind).swatch)}
                      />
                      <span className="sr-only">{kindInfo(holder.kind).label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {directory.total > DIRECTORY_FIRST && query.trim() === "" ? (
              <button
                type="button"
                aria-expanded={showAll}
                onClick={() => setShowAll((value) => !value)}
                className="text-xs text-primary underline-offset-4 hover:underline"
              >
                {showAll ? (changed ? `Show the first ${DIRECTORY_FIRST}` : `Show the largest ${DIRECTORY_FIRST}`) : `Show all ${directory.total} holders`}
              </button>
            ) : null}
            </>
          )}
        </section>
        {/* From lg the tree stays in view while the directory scrolls beside it (spec 14.9). */}
        <div className="min-w-0 lg:sticky lg:top-32 lg:self-start">{children}</div>
      </div>
    </div>
  );
}
