import type { Metadata } from "next";
import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { SuburbContextBar } from "@/components/housing/suburb-context-bar";
import { SuburbProfile } from "@/components/housing/suburb-profile";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getSuburbProfile, resolveSuburbSalCode } from "~/app/actions/getHousing";
import { getStateSuburbIndex } from "~/app/actions/getHousingStateIndex";
import { NotFoundError } from "~/app/actions/withRetry";
import { STATE_NAMES, slugToState, stateSlug, suburbSlug } from "@/lib/housing/states";
import { deriveSuburbContext, type SuburbContext } from "@/lib/housing/suburb-stats";
import { isSuburbIndexable, suburbMetaCopy } from "@/lib/seo/suburb-indexability";

export const revalidate = 86400;

interface PageProps {
  params: Promise<{ state: string; suburb: string }>;
}

// An empty list enables on-demand ISR for this dynamic segment without
// prebuilding or warming the ~15k suburb corpus during deploys.
export function generateStaticParams(): Array<{ state: string; suburb: string }> {
  return [];
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { state, suburb } = await params;
  const code = slugToState(state);
  if (!code) return {};
  const sal = await resolveSuburbSalCode(code, suburb);
  let profile;
  try {
    profile = sal ? await getSuburbProfile(sal) : undefined;
  } catch (error) {
    if (error instanceof NotFoundError) return {};
    throw error;
  }
  if (sal && !profile) {
    throw new Error(`Unable to load suburb profile for SAL ${sal}`);
  }
  const name = profile?.summary?.salName ?? suburb.replace(/-/g, " ");
  const canonicalSlug = profile?.summary
    ? suburbSlug(profile.summary.salName, profile.summary.postcode)
    : suburb.replace(/-$/, "");
  const url = `https://shorted.com.au/housing/${stateSlug(code)}/${canonicalSlug}`;

  // Say what the page can actually show. Priced suburbs keep the existing
  // wording so already-ranking URLs are undisturbed; a suburb with no ingested
  // Valuer-General feed — every one in QLD, WA, ACT, TAS and NT — stops
  // promising a median house price it has never had.
  const summary = profile?.summary;
  const { title, description } = suburbMetaCopy({
    name,
    stateName: STATE_NAMES[code] ?? code,
    latestMedianPrice: summary?.latestMedianPrice,
  });

  // The sitemap gate was a DISCOVERY gate: with no robots directive here, every
  // suburb URL was indexable regardless of what the sitemap advertised. This
  // makes the two agree, with the sitemap a strict subset.
  const indexable = isSuburbIndexable({
    salCode: summary?.salCode,
    salName: summary?.salName,
    latestMedianPrice: summary?.latestMedianPrice,
    population: profile?.demographics?.population,
  });

  return {
    title, description, alternates: { canonical: url },
    robots: indexable ? undefined : { index: false, follow: true },
    openGraph: { type: "website", url, title, description, siteName: "Shorted", locale: "en_AU" },
    twitter: { card: "summary_large_image", title, description, creator: "@shorted___" },
  };
}

export default async function SuburbPage({ params }: PageProps) {
  const { state, suburb } = await params;
  const code = slugToState(state);
  if (!code) notFound();
  // Depends only on `code`, so it starts here and is awaited after the profile —
  // otherwise the page serialises three RPCs it could overlap two of.
  const stateIndex = getStateSuburbIndex(code).catch((error: unknown) => {
    // Degrade to the profile the RPC already returned — but say so, or a
    // persistent state-index outage just looks like a quietly emptier page.
    console.warn(`[suburb] state suburb index unavailable for ${code}:`, error);
    // And do not let ISR bake the degraded render: without this the rank-less
    // page is a perfectly valid cache entry and gets served for the full 24h
    // window, long after the backend recovers.
    bailOnEmptyRender();
    return [];
  });

  // Always resolve from the path. Existing `?sal=` links remain valid, but the
  // query value cannot spoof another state's profile or force dynamic rendering.
  const sal = await resolveSuburbSalCode(code, suburb);
  if (!sal) notFound();
  let profile;
  try {
    profile = await getSuburbProfile(sal);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    throw error;
  }
  if (!profile) {
    throw new Error(`Unable to load suburb profile for SAL ${sal}`);
  }
  if (!profile?.summary) notFound();
  const profileState = slugToState(profile.summary.stateCode);
  if (!profileState) {
    throw new Error(`Suburb profile ${sal} returned invalid state ${profile.summary.stateCode}`);
  }
  const canonicalSlug = suburbSlug(profile.summary.salName, profile.summary.postcode);
  if (profileState !== code || suburb !== canonicalSlug) {
    permanentRedirect(`/housing/${stateSlug(profileState)}/${canonicalSlug}`);
  }
  const name = profile.summary.salName;
  const priced = profile.summary.latestMedianPrice > 0;

  // Rank this suburb inside its own state, and pick its neighbours. This is what
  // retired the 5,000-row fetch the nearby rail used to run in every visitor's
  // browser: the ranking now happens once, on the server, off a cached index.
  const suburbs = await stateIndex;
  const context: SuburbContext | undefined = suburbs.length
    ? deriveSuburbContext(suburbs, {
        salCode: profile.summary.salCode,
        salName: profile.summary.salName,
        stateCode: profile.summary.stateCode,
        postcode: profile.summary.postcode,
        latestMedianPrice: profile.summary.latestMedianPrice,
        yoyPct: profile.summary.yoyPct,
        medianWeeklyHhdIncome: profile.summary.medianWeeklyHhdIncome,
        amenityScore: profile.summary.amenities?.amenityDensityScore ?? 0,
      })
    : undefined;

  return (
    <DashboardLayout>
      {/* Same rule as the on-page provenance line: describe what this suburb
          actually has. QLD, WA, ACT, TAS and NT have no Valuer-General feed, so
          an unpriced suburb must not advertise a median house price to a crawler
          or an LLM either. */}
      <LLMMeta
        title={priced ? `${name} House Prices` : `${name} Suburb Profile`}
        description={priced
          ? `Median house price and demographics for ${name}.`
          : `Demographics, amenities and local context for ${name}.`}
        url={`https://shorted.com.au/housing/${stateSlug(code)}/${suburb}`}
        dataSource={priced ? "ABS Census, state Valuer-General" : "ABS Census"}
        dataFrequency={priced ? "quarterly / 5-yearly" : "5-yearly"}
        keywords={priced
          ? [`${name} house prices`, `${name} demographics`]
          : [`${name} demographics`, `${name} suburb profile`]}
      />
      <div className="mx-auto max-w-[1072px] px-4 pb-14">
        <SuburbContextBar
          stateCode={code}
          suburbName={name}
          salCode={sal}
          neighbours={context?.nearby}
          basis={context?.nearbyBasis}
        />
        <p className="mt-2 text-xs text-muted-foreground">
          For state-level context, explore the{" "}
          <Link
            href={`/economy/${stateSlug(code)}`}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {STATE_NAMES[code]} economy
          </Link>
          .
        </p>
        <div className="pt-6">
          <SuburbProfile
            salCode={sal}
            regionCode={undefined}
            stateCode={code}
            profile={profile}
            context={context}
          />
        </div>
      </div>
    </DashboardLayout>
  );
}
