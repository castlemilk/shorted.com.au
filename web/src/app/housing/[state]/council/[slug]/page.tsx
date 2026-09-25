import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { Breadcrumbs } from "~/@/components/seo/breadcrumbs";
import { BreadcrumbListSchema } from "~/@/components/seo/enhanced-structured-data";
import { CouncilHubMap, CouncilSeriesChart } from "~/@/components/housing/council/council-client";
import {
  CouncilFinances, CouncilWebsite, KeyFactTiles, MemberSuburbs, Neighbours, PeopleAndHousing, PriceDropsPulse,
  Representation, Rollups, Section, SourcesLine,
} from "~/@/components/housing/council/council-sections";
import {
  SITE, councilChartGroups, councilIndexPath, councilJsonLd, councilKeyFacts, councilPath,
  fmtInt, fmtMonth, kindNote,
} from "~/@/lib/housing/council-page";
import { ALL_STATES, STATE_NAMES, slugToState, stateSlug } from "~/@/lib/housing/states";
import { cn } from "~/@/lib/utils";
import { eyebrow, pageTitle } from "~/@/lib/typography";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getCouncilProfile, listCouncils } from "~/app/actions/getHousing";
import { NotFoundError } from "~/app/actions/withRetry";

export const revalidate = 86400;

interface PageProps {
  params: Promise<{ state: string; slug: string }>;
}

/**
 * Every council with a page (kind council | unincorporated, ~550). Empty during
 * a SKIP_STATIC_GENERATION build (listCouncils skips), which leaves them to
 * on-demand ISR — the same posture as the suburb pages.
 */
export async function generateStaticParams(): Promise<Array<{ state: string; slug: string }>> {
  const perState = await Promise.all(
    ALL_STATES.map(async (st) => {
      const res = await listCouncils(st).catch(() => undefined);
      return (res?.councils ?? []).map((c) => ({ state: stateSlug(st), slug: c.slug }));
    }),
  );
  return perState.flat();
}

async function load(state: string, slug: string) {
  const code = slugToState(state);
  if (!code) return { code: undefined, profile: undefined };
  try {
    const res = await getCouncilProfile(code, slug);
    return { code, profile: res?.profile };
  } catch (error) {
    if (error instanceof NotFoundError) return { code, profile: undefined, missing: true };
    throw error;
  }
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { state, slug } = await params;
  const { code, profile } = await load(state, slug);
  if (!code || !profile?.summary) return {};
  const s = profile.summary;
  const url = `${SITE}${councilPath(code, s.slug)}`;
  const place = `${s.displayName}, ${STATE_NAMES[code]}`;
  const title = `${place}: council profile, population, housing and hazards`;
  const description = [
    s.population > 0 ? `${fmtInt(s.population)} residents (ABS estimated resident population ${s.erpYear})` : "",
    s.councilHouseMedian !== undefined && s.councilHouseMedianPeriod ? "council-wide house median" : "",
    "suburbs, hazards, grants, approvals and representation",
  ].filter(Boolean).join(", ");
  return {
    title,
    description: `${place}: ${description}.`,
    alternates: { canonical: url },
    openGraph: { type: "website", url, title, description: `${place}: ${description}.`, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", title, description: `${place}: ${description}.`, creator: "@shorted___" },
  };
}

export default async function CouncilPage({ params }: PageProps) {
  const { state, slug } = await params;
  const { code, profile, missing } = await load(state, slug);
  if (!code || missing) notFound();
  if (!profile?.summary || !profile.council) {
    // A transient API failure: cache the shell for a minute only, so ISR retries soon.
    await bailOnEmptyRender();
    return (
      <DashboardLayout>
        <div className="mx-auto max-w-6xl px-4 py-10 text-sm text-muted-foreground">
          This council&rsquo;s data is loading. Please try again shortly.
        </div>
      </DashboardLayout>
    );
  }

  const s = profile.summary;
  const c = profile.council;
  // The API resolves /council/Sydney to sydney; serve one URL per council.
  if (s.slug && s.slug !== slug) permanentRedirect(councilPath(code, s.slug));
  // Repeated fields default to [] on the wire; guard anyway so a partial cached
  // entry degrades to missing sections rather than a crash.
  const suburbs = profile.suburbs ?? [];
  // A council with members whose member-suburb block failed to load is a
  // partial render: serve it, but do not let ISR pin it for a day.
  if (s.memberSuburbCount > 0 && suburbs.length === 0) await bailOnEmptyRender();
  const neighbours = profile.neighbours ?? [];
  const stateName = STATE_NAMES[code]!;
  const pageUrl = `${SITE}${councilPath(code, s.slug)}`;
  const note = kindNote(code, s.kind, s.displayName);
  const charts = councilChartGroups(profile.series ?? []);
  const facts = councilKeyFacts(s);
  const dominant = suburbs.filter((x) => x.dominant).length;

  const crumbs = [
    { label: "Housing", href: "/housing" },
    { label: stateName, href: `/housing/${stateSlug(code)}` },
    { label: "Councils", href: councilIndexPath(code) },
    { label: s.displayName, href: councilPath(code, s.slug) },
  ];

  return (
    <DashboardLayout>
      <BreadcrumbListSchema
        items={[
          { name: "Home", url: SITE },
          { name: "Housing", url: `${SITE}/housing` },
          { name: stateName, url: `${SITE}/housing/${stateSlug(code)}` },
          { name: "Councils", url: `${SITE}${councilIndexPath(code)}` },
          { name: s.displayName, url: pageUrl },
        ]}
      />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(councilJsonLd(profile, code)) }} />
      <div className="mx-auto max-w-6xl space-y-9 px-4 py-8 sm:py-10">
        <Breadcrumbs items={crumbs} />

        <header className="max-w-4xl border-b border-border/50 pb-7">
          <p className={cn(eyebrow, "mb-2 font-medium")}>
            <Link href={councilIndexPath(code)} className="hover:text-foreground">
              {s.kind === "council" ? `${stateName} council` : `${stateName} · unincorporated area`}
            </Link>
          </p>
          <h1 className={cn(pageTitle, "leading-[1.08]")}>{s.displayName}</h1>
          <p className="mt-4 max-w-3xl text-base leading-relaxed text-muted-foreground">
            {s.population > 0 ? (
              <>
                {fmtInt(s.population)} residents (ABS estimated resident population, 30 June {s.erpYear})
              </>
            ) : null}
            {s.areaSqkm !== undefined ? <>{s.population > 0 ? " across " : ""}{fmtInt(s.areaSqkm)} km²</> : null}
            {dominant > 0 ? <>, {fmtInt(dominant)} suburb{dominant === 1 ? "" : "s"}</> : null}.
            {c.website ? <> Council website: <CouncilWebsite website={c.website} />.</> : null}
          </p>
          {s.dataThrough ? (
            <p className="mt-2 text-xs text-muted-foreground">Council series run to {fmtMonth(s.dataThrough)}.</p>
          ) : null}
          {note ? (
            <p className="mt-4 max-w-3xl rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-muted-foreground" role="note">
              {note}
            </p>
          ) : null}
        </header>

        {suburbs.length ? (
          <CouncilHubMap
            stateCode={code}
            lgaCode={s.lgaCode}
            councilName={s.displayName}
            suburbs={suburbs.map((x) => ({
              salCode: x.salCode, salName: x.salName, postcode: x.postcode, share: x.share, dominant: x.dominant,
            }))}
            neighbourCodes={neighbours.filter((n) => n.sharesBorder && n.stateCode === code).map((n) => n.lgaCode)}
          />
        ) : null}

        <KeyFactTiles facts={facts} />

        {charts.length ? (
          <Section id="trends" title="Trends" lede="Council-level series. Each chart names its source and period.">
            <div className="grid gap-4 lg:grid-cols-2">
              {charts.map((g) => (
                <figure key={g.key} className="rounded-xl border border-border/60 bg-card/40 p-3 sm:p-4">
                  <figcaption className="mb-2">
                    <span className="text-sm font-semibold">{g.title}</span>
                    <span className="mt-0.5 block text-[11px] text-muted-foreground">{g.note}</span>
                  </figcaption>
                  <CouncilSeriesChart lines={g.lines} format={g.format} ariaLabel={`${s.displayName}: ${g.title}`} />
                </figure>
              ))}
            </div>
          </Section>
        ) : null}

        <PeopleAndHousing council={c} />
        <CouncilFinances council={c} />
        <MemberSuburbs stateCode={code} suburbs={suburbs} councilName={s.displayName} />
        {profile.rollup ? (
          <Rollups
            stateCode={code}
            rollup={profile.rollup}
            pricedPeriods={suburbs.filter((x) => x.dominant && x.vgMedian !== undefined && x.vgMedianPeriod).map((x) => x.vgMedianPeriod)}
          />
        ) : null}
        <Representation federal={profile.federalElectorates ?? []} state={profile.stateDistricts ?? []} />
        <PriceDropsPulse stateCode={code} drops={profile.priceDrops} />
        <Neighbours neighbours={neighbours} stateCode={code} />

        {code === "ACT" ? (
          <p className="text-sm text-muted-foreground">
            Explore the territory&rsquo;s suburbs on the{" "}
            <Link href={`/housing/${stateSlug(code)}`} className="text-primary hover:underline">{stateName} suburb map</Link>.
          </p>
        ) : (
          <p className="text-sm text-muted-foreground">
            Compare it with every {stateName} council on the{" "}
            <Link href={`/housing/${stateSlug(code)}?level=council`} className="text-primary hover:underline">council map</Link> or the{" "}
            <Link href={councilIndexPath(code)} className="text-primary hover:underline">{stateName} council list</Link>.
          </p>
        )}
        <SourcesLine profile={profile} />
      </div>
    </DashboardLayout>
  );
}

