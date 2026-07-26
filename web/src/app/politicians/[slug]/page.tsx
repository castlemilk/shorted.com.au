import type { Metadata } from "next";
import { toDate } from "@/lib/politics/timestamp";
import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import {
  CaveatNote,
  CoverageNote,
  DeclaredEntity,
  DeclaredLocation,
  DeclaredPeriod,
  HolderBadge,
  PartyChip,
  SourceLine,
} from "@/components/politicians/compliance";
import { getPolitician } from "~/app/actions/getPoliticians";
import { pageTitle, sectionTitle, eyebrow } from "@/lib/typography";
import { partyLabel } from "@/lib/politics/party-palette";
import { stateSlug, suburbSlug } from "@/lib/housing/states";

// Fully server-rendered: this is the SEO asset, and it needs no interactivity.
export const revalidate = 86400;

// Historical members fill in on demand. generateStaticParams is deliberately
// empty rather than absent — present-but-empty keeps the route on the ISR path
// (the same trick /shorts/[stockCode] relies on).
export function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const data = await getPolitician(slug);
  const p = data?.politician;
  if (!p) return { title: "Politician not found" };

  const url = `https://shorted.com.au/politicians/${p.slug}`;
  const role = p.chamber === "senate" ? `Senator for ${p.stateCode}` : `Member for ${p.division}`;
  const title = `${p.displayName} — Declared Interests (${role})`;
  const description = `What ${p.displayName} declares in the federal register of interests: ${p.declaredListedCount} ASX-listed interests and ${p.declaredPropertyCount} declared properties. The register records what is held, never quantity or value.`;

  // Thin profiles are noindexed: a member with nothing matched adds no value to
  // the index and risks reading as a page about a named person with no content.
  const indexable = p.declaredListedCount > 0 || p.declaredPropertyCount > 0;

  return {
    title,
    description,
    alternates: { canonical: url },
    robots: indexable ? undefined : { index: false, follow: true },
    openGraph: {
      type: "profile",
      url,
      title,
      description,
      siteName: "Shorted",
      locale: "en_AU",
    },
    twitter: { card: "summary_large_image", creator: "@shorted___" },
  };
}

export default async function PoliticianPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const data = await getPolitician(slug);
  const p = data?.politician;
  if (!p) notFound();

  // Slugs are minted server-side and never derived by the client. If the request
  // used an old one, redirect to the canonical.
  if (data?.canonicalSlug && data.canonicalSlug !== slug) {
    permanentRedirect(`/politicians/${data.canonicalSlug}`);
  }

  const url = `https://shorted.com.au/politicians/${p.slug}`;
  const role = p.chamber === "senate" ? `Senator for ${p.stateCode}` : `Member for ${p.division}`;
  const interests = data?.interests ?? [];
  const listed = interests.filter((i) => i.itemNo === 1 || i.itemNo === 4);
  const property = interests.filter((i) => i.itemNo === 3);
  const other = interests.filter((i) => ![1, 3, 4].includes(i.itemNo));
  const asAt = interests
    .map((i) => toDate(i.declaredFrom))
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: p.displayName,
    jobTitle: role,
    url,
    memberOf: {
      "@type": "Organization",
      name: "Parliament of Australia",
      url: "https://www.aph.gov.au",
    },
    ...(p.partyAb ? { affiliation: { "@type": "Organization", name: partyLabel(p.partyAb) } } : {}),
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LLMMeta
        title={`${p.displayName} — declared interests`}
        description={`Register of interests entries for ${p.displayName}, ${role}.`}
        url={url}
        dataSource="Registers of Members' and Senators' Interests, Parliament of Australia"
        dataFrequency="continuous during sitting periods"
      />
      <DashboardLayout>
        <div className="mx-auto max-w-4xl space-y-10 px-4 py-8">
          <header className="space-y-2">
            <p className={eyebrow}>
              <Link href="/politicians" className="hover:underline">
                Parliament&rsquo;s Portfolio
              </Link>
            </p>
            <h1 className={pageTitle}>{p.displayName}</h1>
            <div className="flex flex-wrap items-center gap-3">
              <PartyChip partyAb={p.partyAb} />
              <span className="text-sm text-muted-foreground">{role}</span>
              {p.firstParliament > 0 ? (
                <span className="text-[11px] text-muted-foreground">
                  parliaments {p.firstParliament}
                  {p.lastParliament !== p.firstParliament ? `–${p.lastParliament}` : ""}
                </span>
              ) : null}
            </div>
          </header>

          {/* Stated BEFORE the lists, not as a footnote. An empty list under a
              heading reads as "declared nothing"; that is an absence claim about
              a named person, and it is false wherever we simply have not read
              the documents yet. */}
          <CoverageNote
            extracted={data?.extractedParliaments ?? []}
            partial={data?.partialParliaments ?? []}
            pending={data?.pendingParliaments ?? []}
          />

          <section className="space-y-3">
            <h2 className={sectionTitle}>Declared company interests</h2>
            {listed.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No company interests appear in this member&rsquo;s register entries for the
                parliaments listed above.
              </p>
            ) : (
              <ul className="divide-y">
                {listed.map((i, idx) => (
                  <li key={`${i.declaredText}-${idx}`} className="flex flex-col gap-1 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <DeclaredEntity
                        declaredText={i.declaredText}
                        stockCode={i.stockCode}
                        companyName={i.companyName}
                      />
                      <HolderBadge holder={i.holder} />
                      {i.itemNo === 4 ? (
                        <span className="text-[10px] text-muted-foreground">directorship</span>
                      ) : null}
                    </div>
                    <DeclaredPeriod
                      from={toDate(i.declaredFrom)}
                      fromKnown={i.declaredFromKnown}
                      to={toDate(i.declaredTo)}
                      currentlyDeclared={i.currentlyDeclared}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="space-y-3">
            <h2 className={sectionTitle}>Declared real estate</h2>
            <p className="text-[11px] text-muted-foreground">
              The registers record location at suburb or area level only.
            </p>
            {property.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No real estate appears in this member&rsquo;s register entries for the parliaments
                listed above.
              </p>
            ) : (
              <ul className="divide-y">
                {property.map((i, idx) => (
                  <li key={`${i.declaredText}-${idx}`} className="flex flex-col gap-1 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <DeclaredLocation
                        declaredText={i.declaredText}
                        suburbName={i.suburbName}
                        stateCode={i.propertyState}
                        salCode={i.salCode}
                        href={
                          i.salCode && i.suburbName && i.propertyState
                            ? `/housing/${stateSlug(i.propertyState)}/${suburbSlug(i.suburbName, "")}?sal=${i.salCode}`
                            : undefined
                        }
                      />
                      <HolderBadge holder={i.holder} />
                      {i.secondaryText ? (
                        <span className="text-[11px] text-muted-foreground">{i.secondaryText}</span>
                      ) : null}
                    </div>
                    <DeclaredPeriod
                      from={toDate(i.declaredFrom)}
                      fromKnown={i.declaredFromKnown}
                      to={toDate(i.declaredTo)}
                      currentlyDeclared={i.currentlyDeclared}
                    />
                  </li>
                ))}
              </ul>
            )}
          </section>

          {(data?.representedSuburbs?.length ?? 0) > 0 && (
            <section className="space-y-2">
              <h2 className={sectionTitle}>Suburbs represented</h2>
              <p className="text-[11px] text-muted-foreground">
                Suburbs in {p.division}. Representing a suburb has nothing to do with owning
                anything in it.
              </p>
              {/* <details> keeps the list in the DOM (crawlable) while collapsed. */}
              <details className="text-sm">
                <summary className="cursor-pointer text-muted-foreground">
                  {data?.representedSuburbs.length} suburbs
                </summary>
                <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                  {data?.representedSuburbs.join(" · ")}
                </p>
              </details>
            </section>
          )}

          {other.length > 0 && (
            <section className="space-y-3">
              <h2 className={sectionTitle}>Other declared interests</h2>
              <ul className="divide-y">
                {other.map((i, idx) => (
                  <li key={`${i.itemNo}-${idx}`} className="flex flex-col gap-1 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm">{i.declaredText}</span>
                      <HolderBadge holder={i.holder} />
                      <span className="text-[10px] text-muted-foreground">{i.itemLabel}</span>
                    </div>
                    {i.secondaryText ? (
                      <span className="text-[11px] text-muted-foreground">{i.secondaryText}</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          )}

          <footer className="space-y-3 border-t pt-6">
            <SourceLine
              asAt={asAt}
              pdfUrl={interests[0]?.sourceUrl}
              surface={`profile ${p.displayName}`}
            />
            <CaveatNote />
          </footer>
        </div>
      </DashboardLayout>
    </>
  );
}
