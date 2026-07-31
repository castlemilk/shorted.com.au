/**
 * WHICH SET OF NUMBERS THE PROFILE PUBLISHES, and the date its "last updated"
 * tile is allowed to carry.
 *
 * Both decisions used to live inline in `app/politicians/[slug]/page.tsx`, where
 * neither could be tested and both were wrong in the same direction: they
 * trusted the analytics rpc's SHAPE instead of its CONTENT, and published a
 * refresh clock as if it were a filing date.
 *
 *   - THE FALLBACK PREDICATE IS "ANY CURRENT COUNT", NEVER "ANY ROW". The
 *     explorer rpc emits all fourteen register items whether or not the member
 *     declares under them, so a cold materialized view (migrations are applied
 *     by hand on prod) and the register kill switch both answer with fourteen
 *     ZEROED rows. A length check reads that as a healthy answer and renders
 *     "0 entries currently declared" above a populated declarations table —
 *     an absence claim about a named person, made on our own infrastructure
 *     failure. This is the same predicate the read path already uses to decide
 *     whether a cached response is populated (`isPopulatedProfile`,
 *     getPoliticianExplorerProfile.ts), and the two must not drift.
 *   - "REGISTER LAST UPDATED" IS THE MEMBER'S OWN NEWEST DATE. Never a
 *     refresh-derived one. See `registerLastUpdated` below.
 *
 * Everything here is pure and duck-typed: it takes the plain fields it reads
 * rather than the generated message types, so it can be exercised without the
 * protobuf runtime.
 */

import { registerItem } from "@/lib/politics/register-items";

export interface ProfileItemCount {
  itemNo: number;
  label: string;
  currentCount: number;
}

export interface ProfileHolderCount {
  /** A `RegisterHolder` value. Kept as a number so this module imports no proto. */
  holder: number;
  currentCount: number;
}

/** The analytics rpc's aggregates, as much of them as this decision reads. */
export interface ExplorerProfileAggregates {
  itemCounts?: readonly { itemNo: number; itemLabel: string; currentCount: number }[];
  holderCounts?: readonly { holder: number; currentCount: number }[];
  undatedCount?: number;
}

/** The fields of a published register row the fallback is derived from. */
export interface DeclaredRowFacts {
  itemNo: number;
  itemLabel: string;
  holder: number;
  currentlyDeclared: boolean;
  declaredFromKnown: boolean;
}

export interface ProfileAggregates {
  itemCounts: ProfileItemCount[];
  holderCounts: ProfileHolderCount[];
  /** Current entries with no stated start date — the timeline cannot plot them. */
  undatedCount: number;
  /**
   * Which side answered. The page renders one or the other and never a mixture,
   * so this is also the honest label for "where did these numbers come from".
   */
  source: "explorer" | "rows";
}

/**
 * A category name for a count.
 *
 * The register's own taxonomy first, then the form's own label, then an explicit
 * "not stated" — never an invented category. An unknown item number is a gap in
 * OUR record and is labelled as one.
 */
export function itemLabelFor(itemNo: number, formLabel: string): string {
  return registerItem(itemNo)?.label ?? (formLabel || "Category not stated");
}

/**
 * Does the analytics response actually carry counts?
 *
 * NOT `itemCounts.length > 0`. See the file header: the rpc emits a row per
 * register item whether or not anything is declared under it, so the length is
 * 14 for a healthy member, a cold view and a disabled register alike.
 */
export function hasExplorerCounts(explorer?: ExplorerProfileAggregates): boolean {
  return (explorer?.itemCounts ?? []).some((count) => count.currentCount > 0);
}

/** Per-item counts of currently-declared rows, derived from the rows themselves. */
function itemCountsFromRows(rows: readonly DeclaredRowFacts[]): ProfileItemCount[] {
  const byItem = new Map<number, ProfileItemCount>();
  for (const row of rows) {
    if (!row.currentlyDeclared) continue;
    const existing = byItem.get(row.itemNo);
    if (existing) existing.currentCount += 1;
    else
      byItem.set(row.itemNo, {
        itemNo: row.itemNo,
        label: itemLabelFor(row.itemNo, row.itemLabel),
        currentCount: 1,
      });
  }
  return [...byItem.values()].sort((a, b) => a.itemNo - b.itemNo);
}

function holderCountsFromRows(rows: readonly DeclaredRowFacts[]): ProfileHolderCount[] {
  const byHolder = new Map<number, number>();
  for (const row of rows) {
    if (!row.currentlyDeclared) continue;
    byHolder.set(row.holder, (byHolder.get(row.holder) ?? 0) + 1);
  }
  return [...byHolder.entries()].map(([holder, currentCount]) => ({ holder, currentCount }));
}

function undatedCountFromRows(rows: readonly DeclaredRowFacts[]): number {
  return rows.filter((row) => row.currentlyDeclared && !row.declaredFromKnown).length;
}

/**
 * The rpc's aggregates where they exist, the rows' own where they do not.
 *
 * ONE CONDITION DRIVES ALL THREE MEASURES. A half-explorer/half-fallback tile
 * row would put two different denominators on the same screen — a holder split
 * that does not add up to the entry count beside it invites the reader to
 * conclude something about the member rather than about our pipeline.
 *
 * THE FALLBACK IS EDITORIAL, NOT DEFENSIVE PADDING. The rows are already on the
 * page, so the same counts are derivable here; when the view is live the rpc's
 * numbers win. And a member who GENUINELY declares nothing current lands here
 * too, and gets honest zeros derived from their own rows — the tiles read 0, the
 * donuts render nothing, and the CoverageNote above the lists carries the
 * explanation of what we have actually read.
 */
export function selectProfileAggregates(
  explorer: ExplorerProfileAggregates | undefined,
  rows: readonly DeclaredRowFacts[],
): ProfileAggregates {
  if (hasExplorerCounts(explorer)) {
    return {
      itemCounts: (explorer?.itemCounts ?? []).map((count) => ({
        itemNo: count.itemNo,
        label: itemLabelFor(count.itemNo, count.itemLabel),
        currentCount: count.currentCount,
      })),
      holderCounts: (explorer?.holderCounts ?? []).map((count) => ({
        holder: count.holder,
        currentCount: count.currentCount,
      })),
      undatedCount: explorer?.undatedCount ?? 0,
      source: "explorer",
    };
  }
  return {
    itemCounts: itemCountsFromRows(rows),
    holderCounts: holderCountsFromRows(rows),
    undatedCount: undatedCountFromRows(rows),
    source: "rows",
  };
}

/**
 * The date behind the "register last updated" tile.
 *
 * THE MEMBER'S OWN NEWEST DATE, AND NOTHING ELSE: the newest dated change we
 * hold for them, then the newest start date their own entries carry.
 *
 * NEVER A REFRESH-DERIVED VALUE. The analytics response's `as_at` is the clock
 * the rollup was rebuilt on, so threading it in here printed TODAY on the ~80%
 * of profiles whose entries carry no stated date — a published claim that a
 * member updated their register on a day nobody filed anything, sitting in a
 * tile beside their name and their photograph.
 *
 * Returns undefined when neither date exists, and the caller renders NO TILE.
 * An em dash in a date tile is still a tile asserting we know when the register
 * last moved; withholding is the only honest answer when we do not.
 */
export function registerLastUpdated(
  latestChangedOn?: Date,
  newestDeclaredFrom?: Date,
): Date | undefined {
  return latestChangedOn ?? newestDeclaredFrom;
}
