import { safeExternalHref } from "~/@/lib/safe-external-href";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { fundHref, formatHeadlinePct, shortSector } from "~/@/lib/ownership/kinds";
import { fundLabel, type FundRow } from "../../funds/fund-model";
import { OTHER_SECTOR } from "../../desk/map-layout";
import type { InspectorContent } from "../inspector-types";

/**
 * The fund's reading (spec 14.1, backlog C1): the file date and the largest named sector's weight, or the top
 * ten's weight when the file names no sector with a weight. The placeholder "Other" is a tail, not a sector,
 * so it never leads the reading. The change since the previous file is not in the row, so no clause for it is
 * printed. Null (no reading) when neither figure is stated.
 */
export function fundReading(fund: FundRow): string | undefined {
  const label = fundLabel(fund);
  const top = fund.sectorWeights
    .filter(
      (sector) =>
        sector.industry !== "" &&
        sector.industry !== OTHER_SECTOR &&
        sector.weightPct !== null &&
        Number.isFinite(sector.weightPct),
    )
    .reduce<{ industry: string; weightPct: number } | null>(
      (best, sector) =>
        best === null || (sector.weightPct ?? 0) > best.weightPct
          ? { industry: sector.industry, weightPct: sector.weightPct ?? 0 }
          : best,
      null,
    );
  let figure: string | undefined;
  if (top !== null) figure = `${shortSector(top.industry)} ${formatHeadlinePct(top.weightPct)}`;
  else if (fund.top10Pct !== null && Number.isFinite(fund.top10Pct)) figure = `the top 10 hold ${formatHeadlinePct(fund.top10Pct)}`;
  if (figure === undefined) return undefined;
  const head = [label, fund.asAt].filter((part) => part !== "").join(", ");
  return head === "" ? `${figure}.` : `${head}: ${figure}.`;
}

/**
 * The inspector content for a fund (spec 14.3, Funds): the ticker in the serif,
 * the name beneath, the ETF or Pooled or Super option badge, the reported
 * equities as the one figure, the three largest positions as bars, and the one
 * primary action, Open portfolio. Plain data: the funds page's resolver returns it
 * across the server boundary, and the rail draws it without formatting a figure.
 */
export function fundInspectorContent(fund: FundRow): InspectorContent {
  const badge = fund.sourceKind === "super_phd" ? "Super option" : fund.pooled ? "Pooled" : "ETF";
  const largest = fund.largest.filter((holding) => holding.weightPct !== null).slice(0, 3);
  const top = Math.max(0, ...largest.map((holding) => holding.weightPct ?? 0));
  const source = safeExternalHref(fund.sourceUrl);
  return {
    heading: fundLabel(fund),
    subtitle: fund.name,
    reading: fundReading(fund),
    badges: [badge],
    // The manager's logo at 28 px (spec 14.2): its registry slug, so a monogram where it has no site.
    logo: { kind: "holder", name: fund.institutionName || fundLabel(fund), holderKind: "", holderKey: fund.institutionSlug },
    figure: { value: String(fund.holdings), caption: "reported equities" },
    rows: [
      { label: "Holdings as at", value: fund.asAt || NOT_AVAILABLE },
      { label: "In the top 10", value: formatHeadlinePct(fund.top10Pct) },
      { label: "Manager", value: fund.institutionName || NOT_AVAILABLE },
    ],
    sections:
      largest.length > 0
        ? [
            {
              title: "Largest positions",
              kind: "bars",
              items: largest.map((holding) => ({
                label: holding.code,
                value: formatHeadlinePct(holding.weightPct),
                share: top > 0 ? (holding.weightPct ?? 0) / top : 0,
              })),
            },
          ]
        : [],
    primary: { label: "Open portfolio →", href: fundHref(fund.key) },
    links: source ? [{ label: "View holdings source", href: source, external: true }] : [],
    footnote: "Source-reported weights · Equity holdings shown · Cash excluded",
  };
}
