/**
 * Pure view-model helpers for the council hub (/housing/[state]/council/[slug]).
 *
 * The rules every helper here answers to:
 *   - a council median is COUNCIL-WIDE and says so; it is never a suburb's;
 *   - every figure carries its date;
 *   - population is the ABS estimated resident population, labelled as such;
 *   - an absent fact is omitted — never rendered as 0.
 */
import type { CouncilProfile, CouncilSeries, CouncilSummary } from "~/gen/shorts/v1alpha1/housing_pb";
import type { HousingSeriesFormat } from "@/components/housing/series-data";
import { fmtPriceShort } from "./price-scale";
import { STATE_NAMES, stateSlug } from "./states";

export const SITE = "https://shorted.com.au";

export function councilPath(stateCode: string, slug: string): string {
  return `/housing/${stateSlug(stateCode)}/council/${slug}`;
}

export function councilIndexPath(stateCode: string): string {
  return `/housing/${stateSlug(stateCode)}/council`;
}

/** "Canterbury-Bankstown" for a council; the ABS name already says "Unincorporated". */
export function councilTitle(summary: Pick<CouncilSummary, "displayName" | "kind">): string {
  return summary.kind === "council" ? `${summary.displayName} council` : summary.displayName;
}

export const fmtInt = (v: number) => Math.round(v).toLocaleString("en-AU");
export const fmtMoney = (v: number) => `$${fmtInt(v)}`;
export const fmtSignedPct = (v: number, dp = 1) => `${v > 0 ? "+" : ""}${v.toFixed(dp)}%`;
export const fmtSharePct = (v: number) => (v > 0 && v < 1 ? "<1%" : `${Math.round(v)}%`);
export const fmtShare = (share: number) => `${Math.max(1, Math.round(share * 100))}%`;

/** '2026-06-30' → 'Jun 2026'. */
export function fmtMonth(period: string): string {
  const d = new Date(`${period}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return period;
  return d.toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" });
}

export interface KeyFact {
  label: string;
  value: string;
  note: string;
}

/** Headline tiles. Each is omitted when its source does not cover the council. */
export function councilKeyFacts(s: CouncilSummary): KeyFact[] {
  const facts: KeyFact[] = [];
  if (s.population > 0) {
    facts.push({
      label: "Population",
      value: fmtInt(s.population),
      note: `ABS estimated resident population, 30 June ${s.erpYear}${
        s.popGrowthPct !== undefined ? ` · ${fmtSignedPct(s.popGrowthPct)} in a year` : ""
      }`,
    });
  }
  if (s.densityPerSqkm !== undefined) {
    facts.push({
      label: "Density",
      value: `${fmtInt(s.densityPerSqkm)}/km²`,
      note: `${s.areaSqkm !== undefined ? `${fmtInt(s.areaSqkm)} km² · ` : ""}ERP ${s.erpYear} over the ABS 2024 boundary`,
    });
  }
  if (s.councilHouseMedian !== undefined && s.councilHouseMedianPeriod) {
    facts.push({
      label: "Council-wide house median",
      value: fmtPriceShort(s.councilHouseMedian),
      note: `Established-house transfers across the whole council, FY ${s.councilHouseMedianPeriod} (ABS)`,
    });
  }
  if (s.fagPerResident !== undefined && s.fagYear) {
    facts.push({
      label: "Federal grants per resident",
      value: fmtMoney(s.fagPerResident),
      note: `Financial Assistance Grant ${s.fagYear} over ERP ${s.erpYear}`,
    });
  }
  if (s.approvalsPer1000 !== undefined && s.approvalsThrough) {
    facts.push({
      label: "Dwelling approvals",
      value: `${s.approvalsPer1000.toFixed(1)} per 1,000`,
      note: `Residents, 12 months to ${fmtMonth(`${s.approvalsThrough}-01`)} (ABS Building Approvals)`,
    });
  }
  if (s.seifaIrsadDecile !== undefined) {
    facts.push({
      label: "Advantage decile",
      value: `${s.seifaIrsadDecile} of 10`,
      note: "SEIFA 2021 IRSAD, national (10 = most advantaged)",
    });
  }
  if (s.memberSuburbCount > 0) {
    facts.push({
      label: "Suburbs",
      value: fmtInt(s.memberSuburbCount),
      note: "Where it holds most residents (ABS mesh-block allocation)",
    });
  }
  return facts;
}

export interface ChartGroup {
  key: string;
  title: string;
  note: string;
  format: HousingSeriesFormat;
  lines: Array<{ label: string; points: Array<{ period: string; value: number }> }>;
}

const series = (all: readonly CouncilSeries[], measure: string) => all.find((s) => s.measure === measure);
const pts = (s: CouncilSeries | undefined) => (s?.points ?? []).map((p) => ({ period: p.period, value: p.value }));
const labelRange = (s: CouncilSeries | undefined) => {
  const p = s?.points ?? [];
  return p.length ? `${p[0]!.periodLabel}–${p[p.length - 1]!.periodLabel}` : "";
};

/**
 * The four chart groups, each with serializable points and a format KEY.
 * A group whose series is missing or has a single point is left out.
 */
export function councilChartGroups(all: readonly CouncilSeries[]): ChartGroup[] {
  const groups: ChartGroup[] = [];
  const erp = series(all, "erp");
  if ((erp?.points.length ?? 0) > 1) {
    groups.push({
      key: "population", title: "Population", format: "count",
      note: `ABS estimated resident population at 30 June, ${labelRange(erp)}`,
      lines: [{ label: "Estimated resident population", points: pts(erp) }],
    });
  }
  const house = series(all, "house_median_price");
  const attached = series(all, "attached_median_price");
  const medianLines = [
    (house?.points.length ?? 0) > 1 ? { label: "Houses", points: pts(house) } : null,
    (attached?.points.length ?? 0) > 1 ? { label: "Attached dwellings", points: pts(attached) } : null,
  ].filter((l): l is NonNullable<typeof l> => l !== null);
  if (medianLines.length) {
    groups.push({
      key: "medians", title: "Council-wide median sale prices", format: "aud",
      note: `ABS Data by Region: median transfer price across the whole council by financial year, ${labelRange(house ?? attached)}. Not any one suburb's price.`,
      lines: medianLines,
    });
  }
  const approvals = series(all, "dwelling_approvals_total");
  if ((approvals?.points.length ?? 0) > 1) {
    const houses = series(all, "dwelling_approvals_houses");
    groups.push({
      key: "approvals", title: "Dwelling approvals", format: "count",
      note: `ABS Building Approvals, monthly, ${labelRange(approvals)}`,
      lines: [
        { label: "All dwellings", points: pts(approvals) },
        ...((houses?.points.length ?? 0) > 1 ? [{ label: "Houses", points: pts(houses) }] : []),
      ],
    });
  }
  const fag = series(all, "fag_total_aud");
  if ((fag?.points.length ?? 0) > 1) {
    groups.push({
      key: "grants", title: "Federal Financial Assistance Grants", format: "aud",
      note: `Total grant by financial year, ${labelRange(fag)} (Dept of Infrastructure)`,
      lines: [{ label: "Grant", points: pts(fag) }],
    });
  }
  return groups;
}

/** "Unincorporated ACT" is the ACT Government's area: there are no councils. */
export function isActGovernment(stateCode: string, kind: string): boolean {
  return stateCode === "ACT" && kind === "unincorporated";
}

export function kindNote(stateCode: string, kind: string, name: string): string | null {
  if (isActGovernment(stateCode, kind)) {
    return "The ACT has no local councils. The ACT Government delivers municipal services — roads, waste, planning, libraries — across the whole territory, so ABS treats the territory as one unincorporated area and the Federal Financial Assistance Grant is paid to the ACT Government.";
  }
  if (kind === "unincorporated") {
    return `No council governs ${name}. It is land outside every local government area, administered directly by the ${STATE_NAMES[stateCode] ?? stateCode} government or a state body.`;
  }
  return null;
}

/** Newest date anything on the page is measured to, for lastmod and the dateline. */
export function councilDataThrough(p: CouncilProfile): string | undefined {
  return p.summary?.dataThrough || undefined;
}

/** schema.org JSON-LD: the place, and (for a council) the organisation. */
export function councilJsonLd(p: CouncilProfile, stateCode: string): Record<string, unknown> {
  const s = p.summary!;
  const c = p.council!;
  const url = `${SITE}${councilPath(stateCode, s.slug)}`;
  const areaId = `${url}#area`;
  const sameAs = c.wikidataQid ? [`https://www.wikidata.org/wiki/${c.wikidataQid}`] : undefined;
  const area: Record<string, unknown> = {
    "@type": "AdministrativeArea",
    "@id": areaId,
    name: s.displayName,
    url,
    containedInPlace: { "@type": "State", name: STATE_NAMES[stateCode] ?? stateCode, containedInPlace: { "@type": "Country", name: "Australia" } },
    ...(sameAs ? { sameAs } : {}),
    ...(c.centroidLat !== undefined && c.centroidLon !== undefined
      ? { geo: { "@type": "GeoCoordinates", latitude: c.centroidLat, longitude: c.centroidLon } }
      : {}),
    ...(s.population > 0
      ? {
          additionalProperty: {
            "@type": "PropertyValue",
            name: `ABS estimated resident population, 30 June ${s.erpYear}`,
            value: s.population,
          },
        }
      : {}),
  };
  const graph: Record<string, unknown>[] = [area];
  if (s.kind === "council" && c.website) {
    graph.push({
      "@type": "GovernmentOrganization",
      name: s.displayName,
      url: c.website,
      areaServed: { "@id": areaId },
      ...(sameAs ? { sameAs } : {}),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}
