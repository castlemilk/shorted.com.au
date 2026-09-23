import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { councilHref } from "~/@/lib/housing/council";
import { SITE, councilIndexPath, fmtInt, fmtSharePct, fmtSignedPct } from "~/@/lib/housing/council-page";
import { fmtPriceShort } from "~/@/lib/housing/price-scale";
import { ALL_STATES, STATE_NAMES, slugToState, stateSlug } from "~/@/lib/housing/states";
import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle } from "~/@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { listCouncils } from "~/app/actions/getHousing";

export const revalidate = 86400;

interface PageProps {
  params: Promise<{ state: string }>;
}

export function generateStaticParams(): Array<{ state: string }> {
  return ALL_STATES.map((s) => ({ state: stateSlug(s) }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { state } = await params;
  const code = slugToState(state);
  if (!code) return {};
  const name = STATE_NAMES[code]!;
  const url = `${SITE}${councilIndexPath(code)}`;
  const title = code === "ACT" ? "ACT local government: the territory as one area" : `${name} councils: population, housing, grants and hazards`;
  const description = `Every ${name} local government area in one place: ABS estimated resident population and growth, density, council-wide house medians, federal grants, dwelling approvals, SEIFA and hazard exposure.`;
  return {
    title,
    description,
    alternates: { canonical: url },
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", title, description, creator: "@shorted___" },
  };
}

export default async function StateCouncilsPage({ params }: PageProps) {
  const { state } = await params;
  const code = slugToState(state);
  if (!code) notFound();
  const name = STATE_NAMES[code]!;
  const res = await listCouncils(code);
  const councils = res?.councils ?? [];
  if (councils.length === 0) bailOnEmptyRender();
  const erpYear = councils.find((c) => c.erpYear > 0)?.erpYear;
  const approvalsThrough = councils.find((c) => c.approvalsThrough)?.approvalsThrough;
  const medianPeriod = councils.find((c) => c.councilHouseMedianPeriod)?.councilHouseMedianPeriod;
  const anyHazard = councils.some((c) => c.floodSharePct !== undefined || c.bushfireSharePct !== undefined);
  const url = `${SITE}${councilIndexPath(code)}`;

  const itemList = {
    "@context": "https://schema.org",
    "@type": "ItemList",
    name: `${name} local government areas`,
    numberOfItems: councils.length,
    itemListElement: councils.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.displayName,
      url: `${SITE}${councilHref(code, c.slug, true)}`,
    })),
  };

  return (
    <DashboardLayout>
      <BreadcrumbListSchema
        items={[
          { name: "Home", url: SITE },
          { name: "Housing", url: `${SITE}/housing` },
          { name, url: `${SITE}/housing/${stateSlug(code)}` },
          { name: "Councils", url },
        ]}
      />
      {councils.length ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(itemList) }} />
      ) : null}
      <div className="mx-auto max-w-6xl space-y-7 px-4 py-8 sm:py-10">
        <Breadcrumbs
          items={[
            { label: "Housing", href: "/housing" },
            { label: name, href: `/housing/${stateSlug(code)}` },
            { label: "Councils", href: councilIndexPath(code) },
          ]}
        />
        <header className="max-w-4xl border-b border-border/50 pb-6">
          <p className={cn(eyebrow, "mb-2 font-medium")}>Local government</p>
          <h1 className={cn(pageTitle, "leading-[1.08]")}>{name} councils</h1>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
            {code === "ACT"
              ? "The ACT has no local councils: the ACT Government delivers municipal services across the whole territory, which ABS treats as one unincorporated area."
              : `Every ${name} local government area with the facts we hold for it. Population is the ABS estimated resident population${erpYear ? ` at 30 June ${erpYear}` : ""}; house medians are council-wide, not any suburb's.`}{" "}
            <Link href={`/housing/${stateSlug(code)}?level=council`} className="text-primary hover:underline">See them on the map →</Link>
          </p>
        </header>

        {councils.length === 0 ? (
          <p className="text-sm text-muted-foreground">Council data is loading. Please try again shortly.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-border/60">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Council</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Population{erpYear ? ` (${erpYear})` : ""}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Growth</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Per km²</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">House median{medianPeriod ? ` (${medianPeriod})` : ""}</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Grant / resident</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">Approvals / 1,000</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">IRSAD</th>
                  {anyHazard ? <th scope="col" className="px-3 py-2 text-right font-medium">Flood / bushfire</th> : null}
                </tr>
              </thead>
              <tbody>
                {councils.map((c) => {
                  const href = councilHref(code, c.slug, true);
                  return (
                    <tr key={c.lgaCode} className="border-t border-border/40">
                      <td className="px-3 py-1.5">
                        {href ? <Link href={href} className="font-medium hover:underline">{c.displayName}</Link> : c.displayName}
                        {c.kind === "unincorporated" ? <span className="ml-1.5 text-[10px] text-muted-foreground">unincorporated</span> : null}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{c.population > 0 ? fmtInt(c.population) : ""}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{c.popGrowthPct !== undefined ? fmtSignedPct(c.popGrowthPct) : ""}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{c.densityPerSqkm !== undefined ? fmtInt(c.densityPerSqkm) : ""}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">
                        {c.councilHouseMedian !== undefined && c.councilHouseMedianPeriod
                          ? `${fmtPriceShort(c.councilHouseMedian)}${c.councilHouseMedianPeriod !== medianPeriod ? ` (${c.councilHouseMedianPeriod})` : ""}`
                          : ""}
                      </td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{c.fagPerResident !== undefined && c.fagYear ? `$${fmtInt(c.fagPerResident)}` : ""}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{c.approvalsPer1000 !== undefined ? c.approvalsPer1000.toFixed(1) : ""}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{c.seifaIrsadDecile ?? ""}</td>
                      {anyHazard ? (
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                          {c.floodSharePct !== undefined ? fmtSharePct(c.floodSharePct) : "–"} / {c.bushfireSharePct !== undefined ? fmtSharePct(c.bushfireSharePct) : "–"}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground [text-wrap:pretty]">
          ABS ASGS 2024 local government areas and estimated resident population; council-wide medians from ABS Data by Region;
          grants from the Financial Assistance Grants (Dept of Infrastructure), per ABS resident; approvals from ABS Building Approvals
          {approvalsThrough ? `, 12 months to ${approvalsThrough}` : ""}; SEIFA 2021. Hazard shares are population-weighted over member
          suburbs a state layer covers; a blank cell means no source covers it, not zero. ABS, Dept of Infrastructure and state data CC BY 4.0.
        </p>
      </div>
    </DashboardLayout>
  );
}
