import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { CouncilIndexMap } from "~/@/components/housing/council/council-client";
import { CouncilIndexTable, type CouncilIndexRow } from "~/@/components/housing/council/council-index-table";
import { councilHref } from "~/@/lib/housing/council";
import { SITE, councilIndexPath } from "~/@/lib/housing/council-page";
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
  const approvalsThrough = mostCommon(councils.map((c) => c.approvalsThrough));
  // Headers carry the period most councils are on; a council on another
  // period shows its own beside the value.
  const medianPeriod = mostCommon(councils.map((c) => c.councilHouseMedianPeriod));
  const fagYear = mostCommon(councils.map((c) => (c.fagPerResident !== undefined ? c.fagYear : "")));
  const url = `${SITE}${councilIndexPath(code)}`;
  // Plain JSON for the client table and map (never a protobuf message object).
  const rows: CouncilIndexRow[] = councils.map((c) => ({
    lgaCode: c.lgaCode, slug: c.slug, displayName: c.displayName, kind: c.kind,
    population: c.population, erpYear: c.erpYear, popGrowthPct: c.popGrowthPct, densityPerSqkm: c.densityPerSqkm,
    councilHouseMedian: c.councilHouseMedian, councilHouseMedianPeriod: c.councilHouseMedianPeriod,
    fagPerResident: c.fagPerResident, fagYear: c.fagYear, approvalsPer1000: c.approvalsPer1000,
    approvalsThrough: c.approvalsThrough, seifaIrsadDecile: c.seifaIrsadDecile,
    floodSharePct: c.floodSharePct, bushfireSharePct: c.bushfireSharePct, priceDropShare: c.priceDropShare,
  }));

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
            {code === "ACT" ? (
              <>
                The ACT has no local councils: the ACT Government delivers municipal services across the whole territory, which ABS treats
                as one unincorporated area.{" "}
                <Link href={`/housing/${stateSlug(code)}`} className="text-primary hover:underline">Explore ACT suburbs on the map →</Link>
              </>
            ) : (
              <>
                Every {name} local government area with the facts we hold for it. Population is the ABS estimated resident
                population{erpYear ? ` at 30 June ${erpYear}` : ""}; house medians are council-wide, not any suburb&rsquo;s. Sort the
                table by any column.
              </>
            )}
          </p>
        </header>

        {code !== "ACT" && rows.length > 1 ? (
          <section aria-label={`${name} council map`}>
            <CouncilIndexMap stateCode={code} councils={rows} />
          </section>
        ) : null}

        {councils.length === 0 ? (
          <p className="text-sm text-muted-foreground">Council data is loading. Please try again shortly.</p>
        ) : (
          <CouncilIndexTable stateCode={code} councils={rows} erpYear={erpYear} medianPeriod={medianPeriod} fagYear={fagYear} />
        )}
        <p className="text-[11px] leading-relaxed text-muted-foreground [text-wrap:pretty]">
          ABS ASGS 2024 local government areas and estimated resident population; council-wide medians from ABS Data by Region;
          grants from the Financial Assistance Grants (Dept of Infrastructure){fagYear ? `, ${fagYear},` : ""} per ABS resident; approvals
          from ABS Building Approvals{approvalsThrough ? `, 12 months to ${approvalsThrough}` : ""}; SEIFA 2021. Hazard shares are
          population-weighted over member suburbs a state layer covers, and shown only where covered suburbs hold at least half the
          council&rsquo;s residents; a dash means no source covers enough of it, not zero. ABS, Dept of Infrastructure and state data CC BY 4.0.
        </p>
      </div>
    </DashboardLayout>
  );
}

/** The most common non-empty value (ties to the later-sorting, i.e. newer, period). */
function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  for (const [v, n] of counts) {
    const bn = best ? counts.get(best)! : 0;
    if (n > bn || (n === bn && best !== undefined && v > best)) best = v;
  }
  return best;
}
