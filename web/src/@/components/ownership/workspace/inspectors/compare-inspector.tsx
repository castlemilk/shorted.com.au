import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { fundHref, shortSector } from "~/@/lib/ownership/kinds";
import {
  compareChangesHref,
  compareFunds,
  formatDeltaPp,
  formatWeight,
  fundLabel,
  type FundPortfolio,
  type FundsDiff,
  type OnlyHolding,
  type SectorDiff,
} from "../../funds/fund-model";
import type { InspectorContent, InspectorRow, InspectorSection } from "../inspector-types";

/** The holdings each side lists in the rail before its count says how many there are in all (backlog C5). */
export const COMPARE_ONLY_LIMIT = 10;
/** A difference under this many points rounds to 0.00 at the two decimals the rail prints, so it is not "the" difference. */
const DIFFERENCE_FLOOR_PP = 0.005;
const COMPARE_FOOTNOTE = "Weights are each fund's own file; a difference is of weights, not a trade.";

/**
 * The comparison's reading (spec 14.1, backlog C1 pattern): the sector the two funds differ most in, and which
 * of them is heavier there, then how many holdings only each holds. A clause whose figure is missing drops out,
 * and with no clause left there is no reading at all. The holdings clause needs both files to list holdings: an
 * empty file holds nothing by the record's own word, so it is not counted as a file with no unique holdings.
 */
export function compareReading(
  labels: { first: string; second: string },
  diff: FundsDiff,
  listed: { first: boolean; second: boolean },
): string | undefined {
  const clauses: string[] = [];
  const top = diff.largest;
  const delta = top?.deltaPp ?? null;
  if (top !== null && delta !== null && Math.abs(delta) >= DIFFERENCE_FLOOR_PP) {
    const heavier = delta > 0 ? labels.first : labels.second;
    clauses.push(
      `${labels.first} and ${labels.second} differ most in ${shortSector(top.industry)}, ${Math.abs(delta).toFixed(2)} pp (${heavier} heavier)`,
    );
  }
  if (listed.first && listed.second) {
    const only = diff.onlyFirst.length;
    const other = diff.onlySecond.length;
    clauses.push(`${only} ${only === 1 ? "holding" : "holdings"} only ${labels.first} holds, ${other} only ${labels.second}`);
  }
  if (clauses.length === 0) return undefined;
  return `${clauses.join("; ")}.`;
}

/** A sector's row: each weight printed (n/a when unstated), and the difference with its true minus when both are stated. */
function sectorRow(row: SectorDiff): InspectorRow {
  const weights = `${formatWeight(row.firstPct)} / ${formatWeight(row.secondPct)}`;
  return {
    label: shortSector(row.industry),
    value: row.deltaPp === null ? weights : `${weights} (${formatDeltaPp(row.deltaPp)})`,
  };
}

/** A holding only one fund holds: its code and its weight in that fund. */
function onlyRow(holding: OnlyHolding): InspectorRow {
  return { label: holding.code, value: formatWeight(holding.weightPct) };
}

/** The file date a fund's side is read at, or n/a when the record states none. */
function asAtOf(fund: FundPortfolio): string {
  return fund.asAt === "" ? NOT_AVAILABLE : fund.asAt;
}

/**
 * The inspector content for two funds compared (backlog C5): the heading names both by their labels, the
 * subtitle dates each file, and the sections are the sector weights side by side with their difference, then
 * the holdings only one fund holds (the ten largest each, titled with the count). The primary action opens the
 * Changes page on the first fund, as the bar's link does. Plain data: the funds resolver returns it across the
 * server boundary, and the rail draws it without formatting a figure. The inputs are two portfolios the loader
 * has read in full, so a fund the record does not hold never reaches here.
 */
export function compareInspectorContent(first: FundPortfolio, second: FundPortfolio): InspectorContent {
  const diff = compareFunds(first, second);
  const labels = { first: fundLabel(first), second: fundLabel(second) };
  const sections: InspectorSection[] = [];
  if (diff.sectors.length > 0) {
    sections.push({
      title: `Sector weights, ${labels.first} / ${labels.second}`,
      kind: "rows",
      items: diff.sectors.map(sectorRow),
    });
  }
  // An empty list is left out: a section titled "(0)" over no rows would only mark the rail with a rule.
  if (diff.onlyFirst.length > 0) {
    sections.push({
      title: `Only in ${labels.first} (${diff.onlyFirst.length})`,
      kind: "rows",
      items: diff.onlyFirst.slice(0, COMPARE_ONLY_LIMIT).map(onlyRow),
    });
  }
  if (diff.onlySecond.length > 0) {
    sections.push({
      title: `Only in ${labels.second} (${diff.onlySecond.length})`,
      kind: "rows",
      items: diff.onlySecond.slice(0, COMPARE_ONLY_LIMIT).map(onlyRow),
    });
  }
  return {
    heading: `${labels.first} vs ${labels.second}`,
    subtitle: `${labels.first} at ${asAtOf(first)} · ${labels.second} at ${asAtOf(second)}`,
    reading: compareReading(labels, diff, {
      first: first.holdings.length > 0,
      second: second.holdings.length > 0,
    }),
    rows: [],
    sections,
    primary: { label: "Compare portfolios →", href: compareChangesHref(first.key) },
    links: [
      { label: `${labels.first} portfolio`, href: fundHref(first.key) },
      { label: `${labels.second} portfolio`, href: fundHref(second.key) },
    ],
    footnote: COMPARE_FOOTNOTE,
  };
}
