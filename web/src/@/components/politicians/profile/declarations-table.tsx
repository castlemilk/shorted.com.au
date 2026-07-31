"use client";

/**
 * The declarations surface on a member's profile.
 *
 * PROGRESSIVE ENHANCEMENT IS THE BAR, not a nice-to-have. This page is the SEO
 * asset for a named person, so EVERY published row has to be in the server HTML:
 * a crawler, a reader with JavaScript off, and a reader-mode extraction all see
 * the complete set. This island therefore does not FETCH anything and does not
 * paginate — it receives every row already rendered and only narrows what is on
 * screen once a reader asks it to. The first paint (server and hydrated) is
 * unfiltered by construction.
 *
 * WHY THE ROWS ARRIVE AS `content: ReactNode`. Each row is built on the SERVER
 * from the frozen compliance kit (RegisterItemTag, HolderBadge, DeclaredPeriod,
 * SourceDocLink, the deep links). compliance.tsx has no "use client" and imports
 * the generated protobuf enum, so importing it from here would drag
 * @bufbuild/protobuf across the RSC boundary and take the route's build down
 * with the undiagnosable "Element type is invalid … got: undefined" — the
 * failure documented in CLAUDE.md and pinned by client-boundary.test.ts. The row
 * MARKUP stays server-side; only the plain, serialisable fields the filters read
 * (category, holder, a lowercase haystack) cross the boundary.
 *
 * EDITORIAL. Filtering is a view control and says nothing about the member. The
 * empty state is about the FILTER ("no entries match"), never about the register
 * — an absence claim about a named person belongs to the CoverageNote above,
 * which states what we have actually read.
 */

import { useMemo, useState, type ReactNode } from "react";

import { Input } from "@/components/ui/input";

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
  /** The row itself, rendered on the server with the compliance kit. */
  content: ReactNode;
}

export interface DeclarationsTableProps {
  rows: DeclarationRow[];
}

const ALL = "all";

function countLabel(count: number): string {
  return count === 1 ? "1 entry" : `${count} entries`;
}

export function DeclarationsTable({ rows }: DeclarationsTableProps) {
  const [category, setCategory] = useState<string>(ALL);
  const [holder, setHolder] = useState<string>(ALL);
  const [query, setQuery] = useState("");

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

  // Groups preserve the server's order, so the filtered view reads the same way
  // the unfiltered HTML does.
  const groups = useMemo(() => {
    const out: { key: string; label: string; rows: DeclarationRow[] }[] = [];
    for (const row of visible) {
      const last = out[out.length - 1];
      if (last && last.key === row.categoryKey) last.rows.push(row);
      else out.push({ key: row.categoryKey, label: row.categoryLabel, rows: [row] });
    }
    return out;
  }, [visible]);

  const filtered = category !== ALL || holder !== ALL || needle !== "";

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
                />
              ))}
            </div>
          ) : null}
        </div>

        <p className="text-[11px] text-muted-foreground" role="status">
          Showing {visible.length} of {countLabel(rows.length)}.
          {filtered ? (
            <>
              {" "}
              <button
                type="button"
                onClick={() => {
                  setCategory(ALL);
                  setHolder(ALL);
                  setQuery("");
                }}
                className="underline decoration-dotted underline-offset-2 hover:text-foreground"
              >
                Clear filters
              </button>
            </>
          ) : null}
        </p>
      </div>

      <div id="declaration-panel" role="tabpanel" aria-label="Declared entries">
        {groups.length === 0 ? (
          // About the FILTER, never about the register. What the member has or
          // has not declared is the CoverageNote's job, above.
          <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            No entries match this filter.
          </p>
        ) : (
          <div className="space-y-6">
            {groups.map((group) => (
              <section key={group.key} className="space-y-1">
                {groups.length > 1 ? (
                  <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {group.label}{" "}
                    <span className="tabular-nums font-normal">({group.rows.length})</span>
                  </h3>
                ) : null}
                <ul className="divide-y">
                  {group.rows.map((row) => (
                    <li key={row.id} className="flex flex-col gap-1 py-2">
                      {row.content}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterTab({
  selected,
  onSelect,
  label,
  count,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  count: number;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls="declaration-panel"
      onClick={onSelect}
      className={`rounded-md border px-2 py-1 text-xs ${
        selected ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
      }`}
    >
      {label} <span className="tabular-nums">{count}</span>
    </button>
  );
}

function HolderFilterButton({
  selected,
  onSelect,
  label,
  count,
}: {
  selected: boolean;
  onSelect: () => void;
  label: string;
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={`rounded-md border px-2 py-1 text-[11px] ${
        selected ? "bg-muted font-medium" : "text-muted-foreground hover:bg-muted/50"
      }`}
    >
      {label}
      {count === undefined ? null : <span className="ml-1 tabular-nums">{count}</span>}
    </button>
  );
}
