import type { Metadata } from "next";
import { toDate } from "@/lib/politics/timestamp";
import { notFound, permanentRedirect } from "next/navigation";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import {
  CaveatNote,
  CoverageNote,
  PartyChip,
  SourceLine,
} from "@/components/politicians/compliance";
import {
  PoliticianAvatar,
  PortraitCredit,
} from "@/components/politicians/politician-avatar";
import { CountDonut } from "@/components/politicians/explorer/count-donut";
import { CountTile } from "@/components/politicians/explorer/count-tile";
import { KeyFacts } from "@/components/politicians/explorer/key-facts";
import { TrendArea } from "@/components/politicians/explorer/trend-area";
import {
  HOLDER_FILTER,
  buildDeclarationRows,
} from "@/components/politicians/profile/declaration-rows";
import { DeclarationsTable } from "@/components/politicians/profile/declarations-table";
import { buildProfileKeyFacts } from "@/components/politicians/profile/key-facts";
import {
  IndustryBars,
  RecentChanges,
  ServiceHistory,
  SourceDocuments,
} from "@/components/politicians/profile/sections";
import { getPolitician } from "~/app/actions/getPoliticians";
import { getPoliticianExplorerProfile } from "~/app/actions/getPoliticianExplorerProfile";
import { pageTitle, sectionTitle, eyebrow } from "@/lib/typography";
import { partyLabel } from "@/lib/politics/party-palette";
import { registerItem } from "@/lib/politics/register-items";
import {
  RegisterChangeKind,
  RegisterHolder,
  type DeclaredInterest,
} from "~/gen/shorts/v1alpha1/politicians_pb";

// Fully server-rendered: this is the SEO asset. The one client island (the
// declarations filter) receives already-rendered rows, so every published row is
// in the server HTML whether or not JavaScript runs.
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

/** The register's own item numbers, for the tiles that name one. */
const REAL_ESTATE_ITEM = 3;
const LIABILITY_ITEM = 6;
const GIFT_TRAVEL_ITEMS = [11, 12];

/** Holder order, fixed so every profile reads the same way. */
const HOLDER_ORDER = [
  RegisterHolder.SELF,
  RegisterHolder.SPOUSE_PARTNER,
  RegisterHolder.DEPENDENT_CHILDREN,
  RegisterHolder.UNSPECIFIED,
];

interface ItemCount {
  itemNo: number;
  label: string;
  currentCount: number;
}

function shortDate(date?: Date): string {
  return date
    ? date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
    : "";
}

function itemLabelFor(itemNo: number, formLabel: string): string {
  return registerItem(itemNo)?.label ?? (formLabel || "Category not stated");
}

/**
 * Per-item counts of CURRENTLY-DECLARED rows, derived from the rows themselves.
 *
 * THIS FALLBACK IS EDITORIAL, NOT DEFENSIVE PADDING. The explorer rpc reads a
 * materialized view that the prod deploy does NOT create for itself (migrations
 * are hand-applied), and the register kill switch returns an empty response by
 * design. Either one leaves the analytics absent — and a row of zero tiles beside
 * a named person is an absence claim we would be making on our own infrastructure
 * failure. The rows are already on the page, so the same counts are derivable
 * here; when the view is live the rpc's numbers win.
 */
function itemCountsFrom(interests: DeclaredInterest[]): ItemCount[] {
  const byItem = new Map<number, ItemCount>();
  for (const interest of interests) {
    if (!interest.currentlyDeclared) continue;
    const existing = byItem.get(interest.itemNo);
    if (existing) existing.currentCount += 1;
    else
      byItem.set(interest.itemNo, {
        itemNo: interest.itemNo,
        label: itemLabelFor(interest.itemNo, interest.itemLabel),
        currentCount: 1,
      });
  }
  return [...byItem.values()].sort((a, b) => a.itemNo - b.itemNo);
}

function holderCountsFrom(interests: DeclaredInterest[]): { holder: RegisterHolder; currentCount: number }[] {
  const byHolder = new Map<RegisterHolder, number>();
  for (const interest of interests) {
    if (!interest.currentlyDeclared) continue;
    byHolder.set(interest.holder, (byHolder.get(interest.holder) ?? 0) + 1);
  }
  return [...byHolder.entries()].map(([holder, currentCount]) => ({ holder, currentCount }));
}

/** Current rows whose start date the form never recorded — the timeline cannot plot them. */
function undatedCountFrom(interests: DeclaredInterest[]): number {
  return interests.filter((i) => i.currentlyDeclared && !i.declaredFromKnown).length;
}

function sumItems(counts: ItemCount[], itemNos: number[]): number {
  return counts
    .filter((count) => itemNos.includes(count.itemNo))
    .reduce((sum, count) => sum + count.currentCount, 0);
}

/** A date-shaped tile, matching the count tiles beside it. */
function AsAtTile({ value, label }: { value: string; label: string }) {
  return (
    <article className="rounded-lg border bg-card p-4">
      <div className="text-base font-semibold tabular-nums text-foreground">{value || "—"}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </article>
  );
}

export default async function PoliticianPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const [data, explorer] = await Promise.all([
    getPolitician(slug),
    getPoliticianExplorerProfile(slug),
  ]);
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
  const rows = buildDeclarationRows(interests);
  const asAt = interests
    .map((i) => toDate(i.declaredFrom))
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  // The rpc's aggregates where they exist, the rows' own where they do not. ONE
  // condition drives all three: a half-explorer/half-fallback tile row would put
  // two different denominators on the same screen.
  const hasExplorerCounts = (explorer?.itemCounts ?? []).length > 0;
  const itemCounts: ItemCount[] =
    hasExplorerCounts
      ? (explorer?.itemCounts ?? []).map((count) => ({
          itemNo: count.itemNo,
          label: itemLabelFor(count.itemNo, count.itemLabel),
          currentCount: count.currentCount,
        }))
      : itemCountsFrom(interests);
  const holderCounts =
    hasExplorerCounts && (explorer?.holderCounts ?? []).length > 0
      ? (explorer?.holderCounts ?? []).map((count) => ({
          holder: count.holder,
          currentCount: count.currentCount,
        }))
      : holderCountsFrom(interests);
  const undatedCount = hasExplorerCounts
    ? (explorer?.undatedCount ?? 0)
    : undatedCountFrom(interests);
  const industryCounts = (explorer?.industryCounts ?? []).map((count) => ({
    industry: count.industry,
    companyCount: count.companyCount,
  }));

  const currentEntryCount = itemCounts.reduce((sum, count) => sum + count.currentCount, 0);
  // Distinct ASX codes among the entries declared as current. A count of
  // COMPANIES NAMED, which is all the register supports.
  const currentCompanyCount = new Set(
    interests.filter((i) => i.currentlyDeclared && i.stockCode).map((i) => i.stockCode),
  ).size;
  const realEstateCount = sumItems(itemCounts, [REAL_ESTATE_ITEM]);
  const liabilityCount = sumItems(itemCounts, [LIABILITY_ITEM]);
  const giftTravelCount = sumItems(itemCounts, GIFT_TRAVEL_ITEMS);

  const changes = (explorer?.recentChanges ?? [])
    .map((change, index) => ({
      id: `${change.stockCode || change.declaredText}-${index}`,
      added: change.kind === RegisterChangeKind.ADDED,
      date: shortDate(toDate(change.changedOn)),
      declaredText: change.declaredText,
      itemLabel: change.itemLabel,
      sourceUrl: change.sourceUrl,
      changedOn: toDate(change.changedOn),
    }))
    // Newest first, undated last. An event with no date cannot be placed on the
    // timeline and must not be presented as the most recent one.
    .sort(
      (a, b) =>
        (b.changedOn?.getTime() ?? Number.NEGATIVE_INFINITY) -
        (a.changedOn?.getTime() ?? Number.NEGATIVE_INFINITY),
    );
  const latestChange = changes.find((change) => !!change.changedOn);
  // "Register last updated": the newest dated change we hold for this member,
  // falling back to the extraction's as-at. Never today's date.
  const lastUpdated = latestChange?.changedOn ?? toDate(explorer?.asAt) ?? asAt;

  const sourceDocuments = (explorer?.sourceDocuments ?? []).map((doc) => ({
    label: doc.label,
    sourceUrl: doc.sourceUrl,
    parliament: doc.parliament,
    chamber: doc.chamber,
  }));

  const keyFacts = buildProfileKeyFacts({
    itemCounts,
    holderCounts: holderCounts.map((count) => ({
      key: (HOLDER_FILTER[count.holder] ?? HOLDER_FILTER[RegisterHolder.UNSPECIFIED]!).key,
      currentCount: count.currentCount,
    })),
    industryCounts,
    undatedCount,
    latestChange: latestChange
      ? { date: latestChange.date, href: latestChange.sourceUrl || undefined }
      : undefined,
  });

  const categorySegments = [...itemCounts]
    .filter((count) => count.currentCount > 0)
    .sort((a, b) => b.currentCount - a.currentCount || a.itemNo - b.itemNo)
    .map((count) => ({ label: count.label, count: count.currentCount }));
  const holderSegments = HOLDER_ORDER.map((holder) => ({
    label: (HOLDER_FILTER[holder] ?? HOLDER_FILTER[RegisterHolder.UNSPECIFIED]!).label,
    count: holderCounts.find((count) => count.holder === holder)?.currentCount ?? 0,
  })).filter((segment) => segment.count > 0);
  const timelinePoints = (explorer?.timeline ?? []).map((point) => ({
    month: point.month,
    count: point.declaredCount,
  }));

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
        <div className="mx-auto max-w-6xl space-y-10 px-4 py-8">
          <header className="space-y-2">
            <p className={eyebrow}>
              <Link href="/politicians" className="hover:underline">
                Parliament&rsquo;s Portfolio
              </Link>
            </p>
            <div className="flex items-start gap-4">
              {/*
                A portrait where one is freely licensed, a party-tinted monogram
                otherwise — roughly one member in four has no Commons photograph,
                so the fallback is a designed state rather than a broken one.
                Never an aph.gov.au image: §3.1 publishes extracted facts and
                does not mirror the source's artefacts.
              */}
              <PoliticianAvatar
                displayName={p.displayName}
                partyAb={p.partyAb}
                size="lg"
                photo={{
                  photoUrl: p.photoUrl,
                  photoLicence: p.photoLicence,
                  photoAuthor: p.photoAuthor,
                  photoSourceUrl: p.photoSourceUrl,
                }}
              />
              <div className="min-w-0 space-y-2">
                <h1 className={pageTitle}>{p.displayName}</h1>
                <div className="flex flex-wrap items-center gap-3">
                  <PartyChip partyAb={p.partyAb} />
                  <span className="text-sm text-muted-foreground">{role}</span>
                  {/* The state, for a member whose role names only their seat —
                      "Member for Grayndler" does not tell a reader which state
                      that is, and a Senator's role already carries it. */}
                  {p.chamber !== "senate" && p.stateCode ? (
                    <span className="text-sm text-muted-foreground">{p.stateCode}</span>
                  ) : null}
                  {p.firstParliament > 0 ? (
                    <span className="text-[11px] text-muted-foreground">
                      parliaments {p.firstParliament}
                      {p.lastParliament !== p.firstParliament ? `–${p.lastParliament}` : ""}
                    </span>
                  ) : null}
                </div>
                {/*
                  Terms as a compact service line. Seats and parties change
                  between parliaments, and a register entry belongs to the
                  parliament it was lodged in — so the stints are worth stating
                  rather than flattening into one current label.
                */}
                <ServiceHistory
                  terms={(data?.terms ?? []).map((term) => ({
                    parliament: term.parliament,
                    chamber: term.chamber,
                    division: term.division,
                    stateCode: term.stateCode,
                    partyAb: term.partyAb,
                  }))}
                />
                {/*
                  The credit sits with the face, not in the footer: CC BY / CC
                  BY-SA require attribution alongside the work, and a reader must
                  be able to tell at a glance that this photograph is NOT a
                  Parliament of Australia image.
                */}
                <PortraitCredit
                  photo={{
                    photoUrl: p.photoUrl,
                    photoLicence: p.photoLicence,
                    photoAuthor: p.photoAuthor,
                    photoSourceUrl: p.photoSourceUrl,
                  }}
                />
              </div>
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

          <section className="space-y-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <CountTile count={currentEntryCount} label="entries currently declared" />
              <CountTile count={currentCompanyCount} label="ASX-listed companies named" />
              <CountTile count={realEstateCount} label="real-estate declarations" />
              <CountTile count={liabilityCount} label="liabilities entries" />
              <CountTile count={giftTravelCount} label="gifts and sponsored travel" />
              <AsAtTile value={shortDate(lastUpdated)} label="register last updated" />
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Counts of register <strong>entries</strong> currently declared. The registers record
              what is held and not quantity or value, so none of these is an amount. One real-estate
              entry can cover more than one property, so that figure is a floor rather than a count
              of properties.
            </p>
          </section>

          <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 space-y-10">
              {currentEntryCount > 0 || timelinePoints.length > 0 ? (
                <section className="space-y-6">
                  <h2 className={sectionTitle}>What is declared, at a glance</h2>
                  <div className="grid gap-8 md:grid-cols-2">
                    {categorySegments.length > 0 ? (
                      <CountDonut
                        segments={categorySegments}
                        centerLabel="current entries"
                        title="Declared categories"
                      />
                    ) : null}
                    {holderSegments.length > 0 ? (
                      <CountDonut
                        segments={holderSegments}
                        centerLabel="current entries"
                        title="Who each entry is declared for"
                      />
                    ) : null}
                  </div>
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium text-foreground">
                      Entries declared over time
                    </h3>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Monthly count of currently-declared entries whose start date the register
                      records. Entries with no stated date are never given one.
                    </p>
                    <TrendArea points={timelinePoints} undatedCount={undatedCount} />
                  </div>
                  {industryCounts.length > 0 ? <IndustryBars industries={industryCounts} /> : null}
                </section>
              ) : null}

              <section className="space-y-4">
                <h2 className={sectionTitle}>Declared interests</h2>
                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    Nothing appears in this member&rsquo;s register entries for the parliaments
                    listed above.
                  </p>
                ) : (
                  <>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Every published entry we hold for this member, in the register&rsquo;s own
                      categories and its own words. The registers record location at suburb or area
                      level only. Each entry links to the original document it was read from.
                    </p>
                    <DeclarationsTable rows={rows} />
                  </>
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
            </div>

            <aside className="space-y-6">
              {keyFacts.length > 0 ? <KeyFacts facts={keyFacts} /> : null}
              <RecentChanges changes={changes} />
              <SourceDocuments documents={sourceDocuments} />
              <section className="rounded-lg border bg-card p-4">
                <h2 className={sectionTitle}>Compare</h2>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Put this member&rsquo;s declared entries side by side with another
                  member&rsquo;s. Counts only, both sides the same.
                </p>
                <Link
                  href={`/politicians/compare?a=${p.slug}`}
                  className="mt-2 inline-block text-sm underline decoration-dotted underline-offset-2 hover:text-primary"
                >
                  Compare with…
                </Link>
              </section>
            </aside>
          </div>

          <footer className="space-y-3 border-t pt-6">
            {/*
              A profile spans up to five parliaments and many documents, so a
              single pdfUrl here cited the wrong document for every row but the
              first. Each row now carries its OWN link (SourceDocLink); this
              line keeps the attribution, the as-at date and "report an error",
              and only offers a PDF when every row genuinely shares one.
            */}
            <SourceLine
              asAt={asAt}
              pdfUrl={
                new Set(interests.map((i) => i.sourceUrl).filter(Boolean)).size === 1
                  ? interests[0]?.sourceUrl
                  : undefined
              }
              surface={`profile ${p.displayName}`}
            />
            <CaveatNote />
          </footer>
        </div>
      </DashboardLayout>
    </>
  );
}
