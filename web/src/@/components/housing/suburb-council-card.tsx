// NO "use client" — rendered inside the server-side suburb profile body. Pure
// props in, markup out; every number is already on GetSuburbProfileResponse.
import Link from "next/link";
import type { ReactNode } from "react";
import type { LgaInfo, LgaOverlap } from "~/gen/shorts/v1alpha1/housing_pb";
import { councilHref, fmtCouncilShare } from "@/lib/housing/council";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { HousingIcon } from "./housing-icon";

const fmtMoney = (v: number) => `$${Math.round(v).toLocaleString()}`;
const fmtAUD = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : fmtMoney(v);
const fmtSignedPct = (v: number, dp = 1) => `${v >= 0 ? "+" : ""}${v.toFixed(dp)}%`;

/**
 * Local council — facts about the WHOLE council this suburb sits in.
 *
 * Every figure here is council-level and is labelled that way; the house
 * median in particular is ABS's council-wide median, never this suburb's price
 * (data-sources.md forbids spreading an LGA figure across its suburbs). A fact
 * no source covers is left out rather than shown as zero.
 */
export function SuburbCouncilCard({
  council: c,
  overlaps = [],
  pagesEnabled,
}: {
  council: LgaInfo;
  overlaps?: LgaOverlap[];
  /** Test seam; defaults to COUNCIL_PAGES_ENABLED. */
  pagesEnabled?: boolean;
}) {
  if (!c.lgaName) return null;
  const name = c.displayName || c.lgaName;
  const href = councilHref(c.stateCode, c.slug, pagesEnabled);
  const straddles = overlaps.length > 0 && c.dominantShare !== undefined;

  const census = [
    c.medianAge !== undefined ? `age ${Math.round(c.medianAge)}` : "",
    c.medianHhdIncome !== undefined ? `${fmtMoney(c.medianHhdIncome)}/wk household income` : "",
    c.medianWeeklyRent !== undefined ? `${fmtMoney(c.medianWeeklyRent)}/wk rent` : "",
  ].filter(Boolean);

  const sources = [
    "Council boundaries and the suburb split: ABS ASGS LGA 2024, allocated by 2021 mesh block and weighted by Census 2021 residents.",
    c.erpYear > 0 ? `Population: ABS Estimated Resident Population ${c.erpYear}.` : "",
    census.length > 0 ? "Medians: ABS Census 2021." : "",
    c.councilHouseMedian !== undefined && c.councilHouseMedianPeriod
      ? `House median: ABS Data by Region, established-house transfers across the whole council, financial year ${c.councilHouseMedianPeriod}.`
      : "",
    c.fedFagAud > 0 ? "Federal grants: Financial Assistance Grants, Dept of Infrastructure." : "",
    c.finSource === "vic_lgprf"
      ? `Financials: VIC Local Government Performance Reporting${c.finYear ? ` ${c.finYear}` : ""}, Local Government Victoria.`
      : "",
  ].filter(Boolean);
  // Every CC BY licensor whose data the card shows is named in the licence
  // line — the attribution the licence asks for, not just a source credit.
  const ccBy = [
    "ABS",
    c.fedFagAud > 0 ? "Dept of Infrastructure" : "",
    c.finSource === "vic_lgprf" ? "Local Government Victoria" : "",
  ].filter(Boolean);
  const ccByNames = ccBy.length > 1 ? `${ccBy.slice(0, -1).join(", ")} and ${ccBy[ccBy.length - 1]}` : ccBy[0];

  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2.5 font-serif text-2xl text-foreground">
        <HousingIcon name="council" size={26} /> Local council
      </h2>
      <div className="rounded-lg border border-border bg-card p-4">
        <dl className="grid grid-cols-1 gap-y-2 text-xs">
          <Row label="Council (LGA)">
            {href ? (
              <Link href={href} className="underline-offset-2 hover:underline">
                {name}
              </Link>
            ) : (
              name
            )}
            {straddles ? (
              <span className="font-normal text-muted-foreground"> · {fmtCouncilShare(c.dominantShare!)} of residents</span>
            ) : null}
          </Row>
          {straddles ? (
            <Row label="Also spans" wrap>
              {overlaps.map((o) => `${o.displayName} (${fmtCouncilShare(o.share)})`).join(", ")}
            </Row>
          ) : null}
          <Row label="Population">
            {c.population > 0
              ? `${c.population.toLocaleString()}${c.erpYear > 0 ? ` (${c.erpYear})` : ""}${
                  c.popGrowthPct !== undefined ? ` · ${fmtSignedPct(c.popGrowthPct)} in a year` : ""
                }`
              : "—"}
          </Row>
          {c.population > 0 && c.areaSqkm > 0 ? (
            <Row label="Area / density">
              {`${Math.round(c.areaSqkm).toLocaleString()} km² · ${Math.round(c.population / c.areaSqkm).toLocaleString()}/km²`}
            </Row>
          ) : null}
          {census.length > 0 ? <Row label="Council medians (2021)">{census.join(" · ")}</Row> : null}
          {c.councilHouseMedian !== undefined && c.councilHouseMedianPeriod ? (
            <Row label={`Council-wide house median (${c.councilHouseMedianPeriod})`}>
              {fmtPriceShort(c.councilHouseMedian)}
            </Row>
          ) : null}
          <Row label="Federal grants">
            {c.fedFagAud > 0
              ? `${fmtAUD(c.fedFagAud)}${c.fedFagYear ? ` in ${c.fedFagYear}` : "/yr"}${
                  c.population > 0 ? ` · ${fmtMoney(c.fedFagAud / c.population)}/resident` : ""
                }`
              : "—"}
          </Row>
          {c.avgRates > 0 ? (
            <>
              <Row label="Avg rates / property">{fmtMoney(c.avgRates)}</Row>
              <Row label="Operating result">{fmtSignedPct(c.opSurplusRatio)}</Row>
              <Row label="Asset renewal">{`${Math.round(c.assetRenewalRatio)}%`}</Row>
            </>
          ) : null}
          {c.website ? (
            <Row label="Website">
              <a href={c.website} rel="noopener noreferrer" target="_blank" className="underline-offset-2 hover:underline">
                {websiteLabel(c.website)}
              </a>
            </Row>
          ) : null}
        </dl>
        <p className="mt-2.5 text-[11px] text-muted-foreground [text-wrap:pretty]">
          {sources.join(" ")} {ccByNames} data CC BY 4.0
          {c.website ? "; council website from Wikidata (CC0)" : ""}.
        </p>
      </div>
    </section>
  );
}

function Row({ label, children, wrap = false }: { label: string; children: ReactNode; wrap?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className={`${wrap ? "[text-wrap:pretty]" : "truncate"} text-right font-medium text-foreground`}>{children}</dd>
    </div>
  );
}

/** 'https://www.alburycity.nsw.gov.au/' → 'alburycity.nsw.gov.au'. */
export function websiteLabel(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `${u.hostname.replace(/^www\./, "")}${path}`;
  } catch {
    return url;
  }
}
