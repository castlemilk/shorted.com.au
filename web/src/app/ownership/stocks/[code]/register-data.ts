/**
 * The register page's one read, and the figures its pages share. The page, its
 * metadata, its JSON-LD and its Open Graph card name a stock the same way, so
 * each figure is worked out here once.
 *
 * A plain server module, not "use server": a page's read is not an action.
 * React's cache() lets generateMetadata and the page share one call.
 */

import { cache } from "react";
import type {
  FundHolding,
  GetStockOwnershipResponse,
  OwnershipStock,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { getStockOwnership } from "~/app/actions/getOwnership";
import { cleanCompanyName } from "~/@/lib/company-name";
import { formatPct } from "~/@/lib/fundamentals/format";

/** The response with the summary every register needs; the message type leaves it optional. */
export type RegisterResponse = GetStockOwnershipResponse & { summary: OwnershipStock };

/** The longest title the register uses before the root layout adds " | Shorted". */
const TITLE_MAX = 60;

/**
 * The page's one read. getStockOwnership answers undefined for a failed read, so
 * undefined THROWS: ISR caches whatever a regeneration renders, and a degraded
 * register would sit in the cache for the hour. A response with no summary is
 * not an answer either (a server with no ownership store answers an empty
 * message), so it throws too.
 */
export const readRegister = cache(async (code: string): Promise<RegisterResponse> => {
  const data = await getStockOwnership(code);
  if (!data) {
    throw new Error(`ownership data transiently unavailable for ${code}; failing the ISR render`);
  }
  if (data.summary == null) {
    throw new Error(`ownership summary missing for ${code}; failing the ISR render`);
  }
  return data as RegisterResponse;
});

/**
 * The register knows nothing of the code: no holder, no fund row, no notice, no
 * name and no short figure. Only that is a 404. A company the register names
 * with no current holder is a page, and a noindex one.
 */
export function isUnknownRegister(data: RegisterResponse): boolean {
  const { summary } = data;
  return (
    data.holders.length === 0 &&
    data.fundHoldings.length === 0 &&
    data.historyTotal === 0 &&
    summary.companyName === "" &&
    !summary.hasShortPct
  );
}

/** The name every surface prints: the company's own, cleaned, or the code when the register has none. */
export function registerCompany(code: string, data: RegisterResponse): string {
  return cleanCompanyName(data.summary.companyName || code, code);
}

/**
 * "{CODE} substantial holders: {company}" when it fits, else the head term alone.
 * A company the register has no name for is not repeated as its own code.
 */
export function registerTitle(code: string, company: string): string {
  const head = `${code} substantial holders`;
  const full = company === code ? head : `${head}: ${company}`;
  return full.length <= TITLE_MAX ? full : head;
}

/**
 * The meta description. With no current holder there is no sum to state, so the
 * sentence says that and stops: "n/a interests disclosing n/a" is not a sentence.
 */
export function registerDescription(code: string, company: string, data: RegisterResponse): string {
  const lead = `${company} (ASX:${code}) substantial holders as their ASX notices state them`;
  const { summary } = data;
  if (summary.holders === 0) return `${lead}: no current holder read.`;
  return `${lead}: ${count(interestsOf(summary), "interest")} disclosing ${disclosedOf(summary)} between them, with index fund and super option holdings and the latest ${count(data.historyTotal, "notice")} read since 2024.`;
}

/** A count and its noun, plural for anything but one: "1 holder", "1,117 notices". */
export function count(n: number, noun: string): string {
  return `${n.toLocaleString("en-AU")} ${n === 1 ? noun : `${noun}s`}`;
}

/** Interests counted once: the kinds' holder counts, summed. */
export function interestsOf(summary: OwnershipStock): number {
  return summary.byKind.reduce((total, kind) => total + kind.holders, 0);
}

/** What the notices disclose, to two decimals. It is never a share of the company. */
export function disclosedOf(summary: OwnershipStock): string {
  return formatPct(summary.disclosedPct, { digits: 2 });
}

/** The earliest and latest as-at date among one source's rows; "" where none is dated. */
export function asAtSpan(rows: readonly FundHolding[], sourceKind: string): { from: string; to: string } {
  const dates = rows
    .filter((row) => row.sourceKind === sourceKind && row.asAt !== "")
    .map((row) => row.asAt)
    .sort();
  return { from: dates[0] ?? "", to: dates.at(-1) ?? "" };
}

/** The index fund files holding one stock: how many, and the span of their as-at dates. */
export interface IndexFiles {
  files: number;
  from: string;
  to: string;
}

/**
 * The index fund files the register's table draws, counted the same way: one per
 * fund. The summary carries these figures only for a stock with an ASIC line in
 * the last fortnight, so reading them from the rows keeps the readout, the plate
 * and the sources in agreement with the table beneath them.
 */
export function indexFilesOf(rows: readonly FundHolding[]): IndexFiles {
  const funds = new Set(
    rows.filter((row) => row.sourceKind === "etf").map((row) => `${row.institutionSlug}|${row.fundName}`),
  );
  return { files: funds.size, ...asAtSpan(rows, "etf") };
}
