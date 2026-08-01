/**
 * The profile rail section "Declared by no other member", and the long tail
 * beneath it.
 *
 * THE HEADING IS THE WHOLE CLAIM. `corpus_declarer_count` is a count of members
 * currently declaring a company; a count of one means no other member currently
 * declares it, and that sentence is the entire editorial content of this
 * section. Nothing here calls it distinctive, unusual, rare or notable — those
 * words characterise a named person's holdings, which the rules forbid and which
 * the count does not support (explorer-ui.md §7b, influence-editorial-standards
 * rules 2 and 3). The reader draws the inference; we publish the count.
 *
 * ROW GRAIN IS (company, holder), NOT company. The rpc returns one row per
 * (company, holder) pair on purpose: a member declaring the same code for
 * themselves AND via a spouse holds two different declarations, and collapsing
 * them in the store would have to pick one holder — attributing a spouse's
 * declaration to the member. So the grouping happens HERE, for display only, and
 * every holder in a group keeps its own badge.
 *
 * SILENCE IS THE EMPTY STATE. A member with no sole-declared company renders
 * nothing at all: an empty frame under this heading reads as an absence claim
 * about a named person, and the register cannot support one (we may simply not
 * have read their documents yet — that is what CoverageNote is for).
 *
 * The short-interest chip is a JUXTAPOSITION and nothing more. It is the
 * COMPANY's market-wide ASIC short interest; it says nothing about any member's
 * holding, its size, or any gain or loss. It is muted, never a warning colour,
 * and the API's own disclosure note is rendered beneath the section whenever any
 * chip appears — served with the data so the caveat cannot drift from it.
 */

import Link from "next/link";

import { HolderBadge, ShortInterestCaveat } from "@/components/politicians/compliance";
import { sectionTitle } from "@/lib/typography";
import type { RegisterHolder } from "~/gen/shorts/v1alpha1/politicians_pb";

/** One (company, holder) row, as the rpc serves it. */
export interface DistinctiveHoldingInput {
  stockCode: string;
  companyName: string;
  industry: string;
  holder: RegisterHolder;
  /** Members CURRENTLY declaring this company, across the whole corpus. */
  corpusDeclarerCount: number;
  /** The COMPANY's market-wide short interest. 0 when it carries none. */
  shortPercent: number;
}

/** The same company, with every holder the member declared it under. */
export interface GroupedHolding {
  stockCode: string;
  companyName: string;
  industry: string;
  holders: RegisterHolder[];
  declarerCount: number;
  shortPercent: number;
}

/**
 * How many long-tail companies the rail lists before it says it is truncating.
 *
 * A rail, not a table. The overflow is STATED rather than silent — a list that
 * stops without saying so reads as the whole set.
 */
const MAX_TAIL_ROWS = 6;

/** The long tail this section covers: declared by only two or three members. */
const TAIL_MIN = 2;
const TAIL_MAX = 3;

/**
 * Collapse (company, holder) rows into one row per company.
 *
 * The declarer count and the short percentage are properties of the COMPANY, so
 * every row of a group carries the same value; `Math.max` is defensive rather
 * than meaningful. Holders are kept in the order received and de-duplicated, so
 * a member who declares a code for themselves and via a spouse gets one row with
 * two badges — not two rows, and not one row that silently picks a holder.
 */
export function groupHoldingsByCompany(rows: DistinctiveHoldingInput[]): GroupedHolding[] {
  const byCode = new Map<string, GroupedHolding>();
  for (const row of rows) {
    if (!row.stockCode) continue;
    const existing = byCode.get(row.stockCode);
    if (!existing) {
      byCode.set(row.stockCode, {
        stockCode: row.stockCode,
        companyName: row.companyName,
        industry: row.industry,
        holders: [row.holder],
        declarerCount: row.corpusDeclarerCount,
        shortPercent: row.shortPercent,
      });
      continue;
    }
    if (!existing.holders.includes(row.holder)) existing.holders.push(row.holder);
    existing.declarerCount = Math.max(existing.declarerCount, row.corpusDeclarerCount);
    existing.shortPercent = Math.max(existing.shortPercent, row.shortPercent);
    if (!existing.companyName) existing.companyName = row.companyName;
    if (!existing.industry) existing.industry = row.industry;
  }
  return [...byCode.values()].sort(
    (a, b) => a.declarerCount - b.declarerCount || a.stockCode.localeCompare(b.stockCode),
  );
}

/**
 * The company's own short interest, beside the company.
 *
 * Muted foreground, never amber and never red: a warning colour next to a named
 * member's declaration is the imputation rule 2 exists to prevent. One decimal
 * place, tabular so a column of them lines up.
 */
function ShortInterestChip({ percent }: { percent: number }) {
  if (!(percent > 0)) return null;
  return (
    <span className="inline-flex items-center rounded-sm border border-muted-foreground/25 px-1.5 py-0 text-[10px] font-normal tabular-nums text-muted-foreground">
      {percent.toFixed(1)}% short interest
    </span>
  );
}

/**
 * Companies this member currently declares that no other member currently
 * declares, with the two-or-three-member tail beneath.
 *
 * `moreCount` is the rpc's own cap overflow. The rows it dropped are the ones
 * declared by the MOST members, so it is reported as a plain count of companies
 * not shown — never folded into the sole-declarer figure above it.
 */
export function DistinctiveHoldings({
  holdings,
  disclosureNote,
  moreCount = 0,
}: {
  holdings: DistinctiveHoldingInput[];
  disclosureNote?: string;
  moreCount?: number;
}) {
  const grouped = groupHoldingsByCompany(holdings);
  const sole = grouped.filter((row) => row.declarerCount === 1);
  // Silence, not an empty frame. See the file header.
  if (sole.length === 0) return null;

  const tail = grouped.filter(
    (row) => row.declarerCount >= TAIL_MIN && row.declarerCount <= TAIL_MAX,
  );
  const shownTail = tail.slice(0, MAX_TAIL_ROWS);
  const hiddenTail = tail.length - shownTail.length;

  // The caveat pairs with the CHIPS THAT RENDER, not with the response: a
  // disclosure note under a section carrying no percentage caveats nothing, and
  // a caveat that is always present stops being read.
  const anyChip = [...sole, ...shownTail].some((row) => row.shortPercent > 0);

  return (
    <section className="rounded-lg border bg-card p-4" aria-labelledby="declared-by-no-other-member">
      <h2 id="declared-by-no-other-member" className={sectionTitle}>
        Declared by no other member
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
        ASX-listed companies this member currently declares that no other member currently
        declares. A count of members, not an amount — the registers record what is held and not
        quantity or value.
      </p>
      <ul className="mt-3 space-y-2.5">
        {sole.map((row) => (
          <li key={row.stockCode} className="space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <Link href={`/shorts/${row.stockCode}`} className="text-sm font-medium hover:underline">
                {row.stockCode}
              </Link>
              {row.companyName ? (
                <span className="text-[11px] text-muted-foreground">{row.companyName}</span>
              ) : null}
              {row.holders.map((holder) => (
                <HolderBadge key={`${row.stockCode}-${holder}`} holder={holder} />
              ))}
              <ShortInterestChip percent={row.shortPercent} />
            </div>
            {row.industry ? (
              <p className="text-[10px] text-muted-foreground">{row.industry}</p>
            ) : null}
          </li>
        ))}
      </ul>

      {shownTail.length > 0 ? (
        <div className="mt-4 border-t pt-3">
          <h3 className="text-[11px] font-medium text-foreground">
            Declared by two or three members
          </h3>
          <ul className="mt-1.5 space-y-1 text-[11px] text-muted-foreground">
            {shownTail.map((row) => (
              <li key={row.stockCode} className="flex flex-wrap items-center gap-1.5">
                <Link href={`/shorts/${row.stockCode}`} className="hover:underline">
                  {row.stockCode}
                </Link>
                <span className="tabular-nums">
                  — declared by {row.declarerCount} members
                </span>
                <ShortInterestChip percent={row.shortPercent} />
              </li>
            ))}
          </ul>
          {hiddenTail > 0 ? (
            <p className="mt-1.5 text-[11px] tabular-nums text-muted-foreground">
              +{hiddenTail} more
            </p>
          ) : null}
        </div>
      ) : null}

      {moreCount > 0 ? (
        <p className="mt-3 text-[11px] leading-relaxed tabular-nums text-muted-foreground">
          {moreCount} further declared {moreCount === 1 ? "company is" : "companies are"} not
          shown.
        </p>
      ) : null}

      {/* The kit's caveat, rendering the note the API served WITH the data — the
          wording lives in one place and cannot drift from the figures. */}
      {anyChip ? (
        <div className="mt-3">
          <ShortInterestCaveat note={disclosureNote} />
        </div>
      ) : null}
    </section>
  );
}
