import { safeExternalHref } from "~/@/lib/safe-external-href";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { formatHeadlinePct, formatPointChange, registerHref, shortSector } from "~/@/lib/ownership/kinds";
import {
  formatUnits,
  type PortfolioHolding,
  fundLabel,
} from "../../funds/fund-model";
import type { InspectorContent } from "../inspector-types";

/**
 * One file date's weight of the holding, oldest first. A null is a file that does not
 * state it; `read: false` is a file that could not be read just now (not the same thing).
 */
export interface HoldingSeriesPoint {
  asAt: string;
  weightPct: number | null;
  read?: boolean;
}

/** A series figure: a file that could not be read says so, never "n/a" as if the file had no holding. */
function seriesFigure(point: HoldingSeriesPoint): string {
  return point.read === false ? "Not read just now" : formatHeadlinePct(point.weightPct);
}

export interface HoldingInspectorInput {
  fund: { ticker: string; name: string; asAt: string; sourceUrl: string };
  holding: PortfolioHolding;
  series: readonly HoldingSeriesPoint[];
}

/**
 * The movement between the two newest file dates that both state a weight, as
 * the rail's line, one decimal as the wireframe prints it: "+0.3 percentage points vs
 * 2026-09-30". Null with fewer than two.
 */
export function weightMoveNote(series: readonly HoldingSeriesPoint[]): string | null {
  const stated = series.filter((point) => point.weightPct !== null);
  const latest = stated.at(-1);
  const prior = stated.at(-2);
  if (!latest || !prior || latest.weightPct === null || prior.weightPct === null) return null;
  const delta = latest.weightPct - prior.weightPct;
  const magnitude = Math.abs(delta).toFixed(1);
  if (magnitude === "0.0") return `0.0 percentage points vs ${prior.asAt}`;
  return `${delta > 0 ? "+" : "−"}${magnitude} percentage points vs ${prior.asAt}`;
}

/**
 * The holding's reading (spec 14.1, backlog C1): its weight in the fund on the file date, and the change
 * since the previous file that states one. The weight is the subject, so with no weight there is no reading.
 * The change is printed only when the latest stated file is the one the page shows.
 */
export function holdingReading(input: HoldingInspectorInput): string | undefined {
  const { fund, holding, series } = input;
  if (holding.weightPct === null || !Number.isFinite(holding.weightPct)) return undefined;
  const label = fundLabel(fund);
  const head = [
    `${holding.code} is ${formatHeadlinePct(holding.weightPct)}`,
    label === "" ? "" : `of ${label}`,
    fund.asAt === "" ? "" : `at ${fund.asAt}`,
  ]
    .filter((part) => part !== "")
    .join(" ");
  const stated = series.filter((point) => point.weightPct !== null && Number.isFinite(point.weightPct));
  const latest = stated.at(-1);
  const prior = stated.at(-2);
  const move =
    latest !== undefined &&
    prior !== undefined &&
    fund.asAt !== "" &&
    latest.asAt === fund.asAt &&
    latest.weightPct !== null &&
    prior.weightPct !== null
      ? `${formatPointChange(prior.weightPct, latest.weightPct)} since ${prior.asAt}`
      : undefined;
  return `${[head, move].filter((part) => part !== undefined).join(", ")}.`;
}

/**
 * The inspector content for a holding the file the page shows does not state: the
 * holding's name as the heading, the file it is absent from, and its weight across the
 * file dates that state one, so the rail keeps the record it has. Never "nothing on record".
 */
export function absentHoldingContent(input: {
  fund: { ticker: string; name: string; asAt: string; sourceUrl: string };
  code: string;
  series: readonly HoldingSeriesPoint[];
}): InspectorContent {
  const source = safeExternalHref(input.fund.sourceUrl);
  return {
    heading: `${input.code} in ${fundLabel(input.fund)}`,
    subtitle: input.fund.name,
    logo: { kind: "stock", code: input.code },
    rows: [{ label: "Holdings", value: input.fund.asAt || NOT_AVAILABLE }],
    sections:
      input.series.length > 0
        ? [
            {
              title: "Weight across snapshots",
              kind: "series",
              items: input.series.map((point) => ({ label: point.asAt, value: seriesFigure(point) })),
              // The line's own numbers: null for a file that does not state the weight, never 0 (spec 14.8).
              points: input.series.map((point) => ({ label: point.asAt, value: point.weightPct, read: point.read })),
            },
          ]
        : [],
    note: `${input.code} is not reported in this file.`,
    links: source ? [{ label: "View source holding", href: source, external: true }] : [],
  };
}

/**
 * The inspector content for one holding of one fund (spec 14.3, Fund page): the
 * holding in the fund as the serif heading, the company beneath with its sector,
 * the weight as the figure, the reported shares and the estimated share of the
 * company (n/a unless both units and shares on issue are stated), the weight
 * across the file dates, and the one primary action, the company's ownership.
 */
export function holdingInspectorContent(input: HoldingInspectorInput): InspectorContent {
  const { fund, holding, series } = input;
  const source = safeExternalHref(fund.sourceUrl);
  const move = weightMoveNote(series);
  return {
    heading: `${holding.code} in ${fundLabel(fund)}`,
    reading: holdingReading(input),
    subtitle: `${holding.name} · ${shortSector(holding.industry)}`,
    logo: { kind: "stock", code: holding.code },
    figure: { value: formatHeadlinePct(holding.weightPct), caption: "Weight in this fund" },
    rows: [
      { label: "Reported shares", value: formatUnits(holding.units) },
      // The estimate divides the reported units by the shares on issue, so it is stated
      // only when both are; a figure missing either side reads n/a, never a guess.
      {
        label: "Est. company shares held",
        value:
          holding.units !== null && holding.sharesOnIssue !== null
            ? formatHeadlinePct(holding.estCompanyPct)
            : NOT_AVAILABLE,
      },
      { label: "Holdings", value: fund.asAt || NOT_AVAILABLE },
      { label: "Shares-on-issue basis", value: holding.sharesOnIssueAsAt || NOT_AVAILABLE },
    ],
    sections:
      series.length > 0
        ? [
            {
              title: "Weight across snapshots",
              kind: "series",
              items: series.map((point) => ({ label: point.asAt, value: seriesFigure(point) })),
              // The line's own numbers: null for a file that does not state the weight, never 0 (spec 14.8).
              points: series.map((point) => ({ label: point.asAt, value: point.weightPct, read: point.read })),
            },
          ]
        : [],
    note: move ?? undefined,
    primary: { label: `Open ${holding.code} ownership →`, href: registerHref(holding.code) },
    links: [
      ...(source ? [{ label: "View source holding", href: source, external: true }] : []),
      { label: "Open stock overview →", href: `/shorts/${holding.code}` },
    ],
    footnote: "Weight changes can reflect price moves.",
  };
}
