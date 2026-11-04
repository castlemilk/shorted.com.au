import { safeExternalHref } from "~/@/lib/safe-external-href";
import { NOT_AVAILABLE } from "~/@/lib/fundamentals/format";
import { fundHref } from "~/@/lib/ownership/kinds";
import { formatWeight, fundLabel, type FundRow } from "../../funds/fund-model";
import type { InspectorContent } from "../inspector-types";

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
    badges: [badge],
    // The manager's logo at 28 px (spec 14.2): its registry slug, so a monogram where it has no site.
    logo: { kind: "holder", name: fund.institutionName || fundLabel(fund), holderKind: "", holderKey: fund.institutionSlug },
    figure: { value: String(fund.holdings), caption: "reported equities" },
    rows: [
      { label: "Holdings as at", value: fund.asAt || NOT_AVAILABLE },
      { label: "In the top 10", value: formatWeight(fund.top10Pct, 1) },
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
                value: formatWeight(holding.weightPct, 1),
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
