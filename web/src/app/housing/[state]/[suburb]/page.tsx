import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { HousingBreadcrumb } from "@/components/housing/housing-breadcrumb";
import { SuburbProfile } from "@/components/housing/suburb-profile";
import { getSuburbProfile, resolveSuburbSalCode } from "~/app/actions/getHousing";
import { NotFoundError } from "~/app/actions/withRetry";
import { STATE_NAMES, slugToState, stateSlug, suburbSlug } from "@/lib/housing/states";
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
  return (
    <DashboardLayout>
      <LLMMeta title={`${name} House Prices`} description={`Median house price and demographics for ${name}.`}
        url={`https://shorted.com.au/housing/${stateSlug(code)}/${suburb}`} dataSource="ABS Census, Valuer-General" dataFrequency="quarterly / 5-yearly"
        keywords={[`${name} house prices`, `${name} demographics`]} />
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-8">
        <HousingBreadcrumb stateCode={code} suburb={name} />
        <SuburbProfile
          salCode={sal}
          regionCode={undefined}
          stateCode={code}
          profile={profile}
        />
      </div>
    </DashboardLayout>
  );
}
