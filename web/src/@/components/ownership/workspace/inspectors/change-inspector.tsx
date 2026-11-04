import { safeExternalHref } from "~/@/lib/safe-external-href";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { industryLabel } from "~/@/lib/industry-placeholder";
import { fundHref, formatHeadlinePct, formatPointChange } from "~/@/lib/ownership/kinds";
import {
  formatDeltaPp,
  statusLabel,
  type CompareRow,
  fundLabel,
} from "../../funds/fund-model";
import type { InspectorContent } from "../inspector-types";

export interface ChangeInspectorInput {
  fund: { key: string; ticker: string };
  row: CompareRow;
  from: string;
  to: string;
  /** The earlier and later files' URLs, as the comparison names them. */
  sourceFrom: string;
  sourceTo: string;
}

/** A change in words, for the figure's caption: "+0.10 percentage points". */
export function deltaWords(pp: number | null): string {
  if (pp === null || !Number.isFinite(pp)) return "Held on one file date only";
  if (Math.abs(pp) < 0.005) return "0.00 percentage points";
  return `${pp > 0 ? "+" : "−"}${Math.abs(pp).toFixed(2)} percentage points`;
}

/**
 * The change row's reading (spec 14.1, backlog C1): the two weights and the change in points, then the status
 * when the row is newly reported or no longer reported. A weight pair is printed only when both are stated.
 * With nothing stated there is no reading.
 */
export function changeReading(input: ChangeInspectorInput): string | undefined {
  const { fund, row } = input;
  const weights =
    row.weightFrom !== null && Number.isFinite(row.weightFrom) && row.weightTo !== null && Number.isFinite(row.weightTo)
      ? `${formatHeadlinePct(row.weightFrom)} to ${formatHeadlinePct(row.weightTo)}`
      : undefined;
  const delta = row.deltaPp !== null && Number.isFinite(row.deltaPp) ? formatPointChange(0, row.deltaPp) : undefined;
  const status = row.status === "new" ? "newly reported" : row.status === "dropped" ? "no longer reported" : undefined;
  const tail = [delta, status].filter((part): part is string => part !== undefined);
  if (weights === undefined && tail.length === 0) return undefined;
  const head = `${row.code} in ${fundLabel(fund)}`;
  const lead = weights === undefined ? head : `${head}: ${weights}`;
  return `${[lead, ...tail].join(", ")}.`;
}

/**
 * The fund page's Changes tab, opened on the two files this row compares (spec 14.7):
 * the dates travel with the link, so the history shows the same pair.
 */
export function fundHistoryHref(key: string, from: string, to: string): string {
  const query = new URLSearchParams({ tab: "changes" });
  if (from !== "") query.set("from", from);
  if (to !== "") query.set("to", to);
  return `${fundHref(key)}?${query.toString()}`;
}

/**
 * The inspector content for one row of a fund comparison (spec 14.3, Changes): the
 * company in the fund as the heading, the two weights as the figure with the
 * change in words beneath, the status, the two files as evidence, the note that a
 * weight moves with prices, and the one line a new holding needs: it is not proof
 * of a purchase.
 */
export function changeInspectorContent(input: ChangeInspectorInput): InspectorContent {
  const { fund, row, from, to } = input;
  const sourceFrom = safeExternalHref(input.sourceFrom);
  const sourceTo = safeExternalHref(input.sourceTo);
  const evidence = [
    ...(sourceFrom ? [{ label: `Earlier file, ${from || NOT_AVAILABLE}`, href: sourceFrom, external: true }] : []),
    ...(sourceTo ? [{ label: `Later file, ${to || NOT_AVAILABLE}`, href: sourceTo, external: true }] : []),
  ];
  return {
    heading: `${row.code} in ${fundLabel(fund)}`,
    reading: changeReading(input),
    subtitle: `${row.name} · ${industryLabel(row.industry) || NOT_AVAILABLE}`,
    logo: { kind: "stock", code: row.code },
    figure: {
      value: `${formatHeadlinePct(row.weightFrom)} → ${formatHeadlinePct(row.weightTo)}`,
      caption: deltaWords(row.deltaPp),
      tone: row.deltaPp === null || row.deltaPp === 0 ? undefined : row.deltaPp > 0 ? "up" : "down",
    },
    rows: [
      { label: "Change", value: formatDeltaPp(row.deltaPp) },
      { label: "Status", value: statusLabel(row.status) },
      { label: "Earlier file", value: from || NOT_AVAILABLE },
      { label: "Later file", value: to || NOT_AVAILABLE },
    ],
    sections: evidence.length > 0 ? [{ title: "Evidence", kind: "list", items: evidence }] : [],
    note: "Portfolio weight can change with prices, fund subscriptions and corporate actions.",
    primary: { label: "View fund history →", href: fundHistoryHref(fund.key, from, to) },
    footnote:
      "Newly reported means absent from the earlier file. It is not proof of a new purchase.",
  };
}
