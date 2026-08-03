"use client";

/**
 * The declarations surface on a member's profile — a real, sortable table.
 *
 * PROGRESSIVE ENHANCEMENT IS THE BAR, not a nice-to-have. This page is the SEO
 * asset for a named person, so EVERY published row has to be in the server HTML:
 * a crawler, a reader with JavaScript off, and a reader-mode extraction all see
 * the complete set. This island therefore does not FETCH anything and does not
 * paginate — it receives every row already rendered and only narrows or
 * re-orders what is on screen once a reader asks it to. The first paint (server
 * and hydrated) is unfiltered and in register order by construction.
 *
 * WHY THE CELLS ARRIVE AS `ReactNode`s. Each cell is built on the SERVER from
 * the frozen compliance kit (DeclaredEntity, HolderBadge, DeclaredPeriod,
 * SourceDocLink). compliance.tsx has no "use client" and imports the generated
 * protobuf enum, so importing it from here would drag @bufbuild/protobuf across
 * the RSC boundary and take the route's build down with the undiagnosable
 * "Element type is invalid … got: undefined" — the failure documented in
 * CLAUDE.md and pinned by client-boundary.test.ts. The cell MARKUP stays
 * server-side; only plain, serialisable fields (category, holder, sort keys, a
 * lowercase haystack) cross the boundary for TanStack to filter and sort on.
 *
 * WHY TANSTACK AND A `<table>`. The previous list rendered each entry as one
 * wrapped flex line — entity, holder chip, category chip, source link — so the
 * same chips repeated down the page and nothing aligned. Columns give each
 * fact a fixed place (what · whose · since when · source), the header row
 * names them once instead of per-row chips, and sorting is genuinely useful
 * ("what did they declare most recently"). The semantics also improve: a
 * crawler now sees a captioned table, not a div soup.
 *
 * EDITORIAL. Filtering and sorting are view controls and say nothing about the
 * member. The empty state is about the FILTER ("no entries match"), never about
 * the register — an absence claim about a named person belongs to the
 * CoverageNote above, which states what we have actually read. No column is an
 * amount, because the registers record none.
 */

import { useMemo, useState, type ReactNode } from "react";
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from "@tanstack/react-table";

import { Input } from "@/components/ui/input";
import { PoliticsIcon } from "@/components/politicians/politics-icon";
import { HOLDER_FILTER_ICON, registerItemIcon } from "@/lib/politics/register-item-icons";
import { POLITICS_FOCUS_RING } from "@/lib/politics/control-classes";

export interface DeclarationRow {
  /** Stable within one render of one profile. */
  id: string;
  /** The register's own item number, 1–14. Drives tab order. */
  itemNo: number;
  /** Serialisable grouping key (the item number as a string). */
  categoryKey: string;
  /** The short category label, from the register's own taxonomy. */
  categoryLabel: string;
  /** Serialisable holder key, matching the register's holder attribute. */
  holderKey: string;
  /** Holder label, kept identical to the HolderBadge copy. */
  holderLabel: string;
  /** Lowercased haystack for the text filter. Built server-side. */
  searchText: string;
  /** Lowercased visible name, for sorting the Declared column. */
  entityText: string;
  /** Epoch ms of the declared-from date; 0 when the register states none. */
  sinceEpoch: number;
  /** The four cells, rendered on the server with the compliance kit. */
  entity: ReactNode;
  holder: ReactNode;
  period: ReactNode;
  source: ReactNode;
}

export interface DeclarationsTableProps {
  rows: DeclarationRow[];
}

const ALL = "all";

function countLabel(count: number): string {
  return count === 1 ? "1 entry" : `${count} entries`;
}

/**
 * The column model.
 *
 * Sorting reads ONLY the plain fields — the nodes are opaque to TanStack. An
 * unsorted table keeps the incoming order (register item, then the document
 * order), which is what groups the category sections below.
 */
const COLUMNS: ColumnDef<DeclarationRow>[] = [
  {
    id: "entity",
    accessorKey: "entityText",
    header: "Declared",
    cell: ({ row }) => row.original.entity,
  },
  {
    id: "holder",
    accessorKey: "holderLabel",
    header: "Declared for",
    cell: ({ row }) => row.original.holder,
  },
  {
    id: "since",
    // A 0 epoch is "the register states no date" — surfacing it as undefined
    // lets sortUndefined keep those entries at the END in both directions,
    // rather than masquerading as 1970.
    accessorFn: (row) => (row.sinceEpoch === 0 ? undefined : row.sinceEpoch),
    header: "Period",
    cell: ({ row }) => row.original.period,
    sortUndefined: "last",
    sortDescFirst: false,
  },
  {
    id: "source",
    header: "Source",
    enableSorting: false,
    cell: ({ row }) => row.original.source,
  },
];

export function DeclarationsTable({ rows }: DeclarationsTableProps) {
  const [category, setCategory] = useState<string>(ALL);
  const [holder, setHolder] = useState<string>(ALL);
  const [query, setQuery] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);

  // Tabs in register-item order, each carrying its own count. Derived from the
  // rows rather than from the 14-item taxonomy: a tab for a category this member
  // has never declared would be an empty promise.
  const categories = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; itemNo: number; count: number }>();
    for (const row of rows) {
      const existing = byKey.get(row.categoryKey);
      if (existing) existing.count += 1;
      else
        byKey.set(row.categoryKey, {
          key: row.categoryKey,
          label: row.categoryLabel,
          itemNo: row.itemNo,
          count: 1,
        });
    }
    return [...byKey.values()].sort((a, b) => a.itemNo - b.itemNo || a.label.localeCompare(b.label));
  }, [rows]);

  const holders = useMemo(() => {
    const byKey = new Map<string, { key: string; label: string; count: number }>();
    for (const row of rows) {
      const existing = byKey.get(row.holderKey);
      if (existing) existing.count += 1;
      else byKey.set(row.holderKey, { key: row.holderKey, label: row.holderLabel, count: 1 });
    }
    return [...byKey.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [rows]);

  const needle = query.trim().toLowerCase();

  const visible = useMemo(
    () =>
      rows.filter(
        (row) =>
          (category === ALL || row.categoryKey === category) &&
          (holder === ALL || row.holderKey === holder) &&
          (needle === "" || row.searchText.includes(needle)),
      ),
    [rows, category, holder, needle],
  );

  const table = useReactTable({
    data: visible,
    columns: COLUMNS,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (row) => row.id,
  });

  const filtered = category !== ALL || holder !== ALL || needle !== "";
  // Category section headers only make sense while the rows are still in
  // register order — a user-applied sort interleaves categories on purpose.
  const grouped = sorting.length === 0;
  const tableRows = table.getRowModel().rows;

  if (rows.length === 0) return null;

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <div
          role="tablist"
          aria-label="Filter declarations by register category"
          className="flex flex-wrap gap-1.5"
        >
          <FilterTab
            selected={category === ALL}
            onSelect={() => setCategory(ALL)}
            label="All"
            count={rows.length}
          />
          {categories.map((entry) => (
            <FilterTab
              key={entry.key}
              selected={category === entry.key}
              onSelect={() => setCategory(entry.key)}
              label={entry.label}
              count={entry.count}
              // Derived from the register's own item number, which already
              // crosses the RSC boundary on every row — the icon map is pure
              // data over a generated manifest, so nothing new crosses with it.
              icon={registerItemIcon(entry.itemNo)}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="min-w-56 flex-1">
            <label htmlFor="declaration-filter" className="sr-only">
              Filter declarations by text
            </label>
            <Input
              id="declaration-filter"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter these entries — a company, a suburb, a word…"
              className="h-9 text-sm"
            />
          </div>
          {holders.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                Declared for
              </span>
              <HolderFilterButton
                selected={holder === ALL}
                onSelect={() => setHolder(ALL)}
                label="Anyone"
              />
              {holders.map((entry) => (
                <HolderFilterButton
                  key={entry.key}
                  selected={holder === entry.key}
                  onSelect={() => setHolder(entry.key)}
                  label={entry.label}
                  count={entry.count}
                  // Keyed off the holder key the server row already carries.
                  // "not-stated" is absent from the map on purpose, so that
                  // button renders its label alone — see HOLDER_FILTER_ICON.
                  icon={HOLDER_FILTER_ICON[entry.key]}
                />
              ))}
            </div>
          ) : null}
        </div>

        <p className="text-[11px] text-muted-foreground" role="status">
          Showing {visible.length} of {countLabel(rows.length)}.
          {filtered || sorting.length > 0 ? (
            <>
              {" "}
              <button
                type="button"
                onClick={() => {
                  setCategory(ALL);
                  setHolder(ALL);
                  setQuery("");
                  setSorting([]);
                }}
                className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                {filtered ? "Clear filters" : "Reset order"}
              </button>
            </>
          ) : null}
        </p>
      </div>

      <div id="declaration-panel" role="tabpanel" aria-label="Declared entries">
        {tableRows.length === 0 ? (
          // About the FILTER, never about the register. What the member has or
          // has not declared is the CoverageNote's job, above.
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No entries match this filter.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <caption className="sr-only">
                Declared entries from the Registers of Members&rsquo; and Senators&rsquo;
                Interests, in the register&rsquo;s own words. No column is a quantity or a value;
                the registers record none.
              </caption>
              <thead className="border-b text-[11px] uppercase tracking-wide text-muted-foreground">
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => {
                      const sortable = header.column.getCanSort();
                      const dir = header.column.getIsSorted();
                      return (
                        <th
                          key={header.id}
                          scope="col"
                          aria-sort={
                            dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined
                          }
                          className={`py-2 pr-3 text-left font-normal ${columnHeadClass(header.id)}`}
                        >
                          {sortable ? (
                            <button
                              type="button"
                              onClick={header.column.getToggleSortingHandler()}
                              className={`inline-flex items-center gap-1 ${POLITICS_FOCUS_RING} hover:text-foreground`}
                            >
                              {flexRender(header.column.columnDef.header, header.getContext())}
                              <span aria-hidden className="text-[9px] leading-none">
                                {dir === "asc" ? "▲" : dir === "desc" ? "▼" : "△▽"}
                              </span>
                            </button>
                          ) : (
                            flexRender(header.column.columnDef.header, header.getContext())
                          )}
                        </th>
                      );
                    })}
                  </tr>
                ))}
              </thead>
              <tbody>
                {tableRows.map((row, index) => {
                  const previous = tableRows[index - 1];
                  const showGroupHead =
                    grouped &&
                    (category === ALL ? categories.length > 1 : false) &&
                    (!previous || previous.original.categoryKey !== row.original.categoryKey);
                  return [
                    showGroupHead ? (
                      <tr key={`${row.id}-group`} className="border-b bg-muted/30">
                        {/* A real heading inside the th, so the category keeps
                            its place in the document outline the way the old
                            list's <h3>s did. */}
                        <th
                          scope="colgroup"
                          colSpan={COLUMNS.length}
                          className="py-1.5 pr-3 text-left"
                        >
                          <h3 className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                            {registerItemIcon(row.original.itemNo) ? (
                              <PoliticsIcon
                                name={registerItemIcon(row.original.itemNo)!}
                                size={14}
                              />
                            ) : null}
                            <span>
                              {row.original.categoryLabel}{" "}
                              <span className="tabular-nums font-normal">
                                (
                                {
                                  tableRows.filter(
                                    (r) => r.original.categoryKey === row.original.categoryKey,
                                  ).length
                                }
                                )
                              </span>
                            </span>
                          </h3>
                        </th>
                      </tr>
                    ) : null,
                    <tr
                      key={row.id}
                      className="border-b align-top transition-colors last:border-0 hover:bg-muted/40"
                    >
                      <td className="py-2 pr-3">{row.original.entity}</td>
                      <td className="py-2 pr-3">{row.original.holder}</td>
                      <td className="py-2 pr-3 whitespace-nowrap">{row.original.period}</td>
                      <td className="py-2 text-right">{row.original.source}</td>
                    </tr>,
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function columnHeadClass(id: string): string {
  if (id === "source") return "text-right";
  return "";
}

function FilterTab({
  selected,
  onSelect,
  label,
  count,
  icon,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  count: number;
  icon?: ReturnType<typeof registerItemIcon>;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls="declaration-panel"
      onClick={onSelect}
      // NEVER ICON-ONLY. A tab is how a reader narrows what a named person is
      // shown to have declared, so the category has to be readable as a word —
      // the icon is a second cue beside it, never the whole control.
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${POLITICS_FOCUS_RING} ${
        selected ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
      }`}
    >
      {icon ? <PoliticsIcon name={icon} size={14} /> : null}
      <span>
        {label} <span className="tabular-nums">{count}</span>
      </span>
    </button>
  );
}

function HolderFilterButton({
  selected,
  onSelect,
  label,
  count,
  icon,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  count?: number;
  icon?: ReturnType<typeof registerItemIcon>;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${POLITICS_FOCUS_RING} ${
        selected ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
      }`}
    >
      {icon ? <PoliticsIcon name={icon} size={13} /> : null}
      <span>
        {label}
        {count === undefined ? null : <span className="ml-1 tabular-nums">{count}</span>}
      </span>
    </button>
  );
}
