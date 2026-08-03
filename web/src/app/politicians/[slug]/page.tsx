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
  registerLastUpdated,
  selectProfileAggregates,
  type ProfileItemCount,
} from "@/components/politicians/profile/aggregates";
import {
  HOLDER_FILTER,
  buildDeclarationRows,
} from "@/components/politicians/profile/declaration-rows";
import { DeclarationsTable } from "@/components/politicians/profile/declarations-table";
import { DistinctiveHoldings } from "@/components/politicians/profile/distinctive-holdings";
import { FundingReturns } from "@/components/politicians/profile/funding-returns";
import { buildProfileKeyFacts } from "@/components/politicians/profile/key-facts";
import {
  IndustryBars,
  RecentChanges,
  ServiceHistory,
  SourceDocuments,
} from "@/components/politicians/profile/sections";
import { bailOnEmptyRender } from "~/app/actions/config";
import { getDistinctiveHoldings } from "~/app/actions/getDistinctiveHoldings";
import { getPoliticianFunding } from "~/app/actions/getPoliticianFunding";
import { getPolitician } from "~/app/actions/getPoliticians";
import { getPoliticianExplorerProfile } from "~/app/actions/getPoliticianExplorerProfile";
import { pageTitle, sectionTitle, eyebrow } from "@/lib/typography";
import { partyLabel } from "@/lib/politics/party-palette";
import {
  hasRegisterEntries,
  profileIsIndexable,
  SENATE_REGISTER_GAP,
} from "@/lib/politics/register-coverage";
import { HOLDER_ICON, registerItemIcon } from "@/lib/politics/register-item-icons";
import { SectionIcon } from "@/components/politicians/politics-icon";
import type { PoliticsIconName } from "@/components/politicians/politics-icons.generated";
import {
  RegisterChangeKind,
  RegisterHolder,
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
  // A DESCRIPTION MAY NOT REPORT ZEROES IT CANNOT STAND BEHIND. "0 ASX-listed
  // interests and 0 declared properties" is a finding about a named person, and
  // for a senator whose volume we have not read it is simply false. The senate
  // branch states the coverage gap instead. (This string is noindexed on those
  // profiles anyway — but it is also what a link preview shows.)
  const description =
    p.chamber === "senate" && !hasRegisterEntries(p)
      ? `${p.displayName}, ${role}. ${SENATE_REGISTER_GAP}`
      : `What ${p.displayName} declares in the federal register of interests: ${p.declaredListedCount} ASX-listed interests and ${p.declaredPropertyCount} declared properties. The register records what is held, never quantity or value.`;

  // Thin profiles are noindexed: a member with nothing matched adds no value to
  // the index and risks reading as a page about a named person with no content.
  //
  // The predicate is shared with the sitemap (register-coverage.ts) so the two
  // can never disagree, and it is deliberately blind to AEC funding: a senator
  // whose only content is a lodged return still has an empty register section
  // as the page's main heading. They remain searchable on this site and
  // reachable from the hub roll — just not advertised to a crawler.
  const indexable = profileIsIndexable(p);

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

/**
 * Holder order, fixed so every profile reads the same way.
 *
 * Typed as plain numbers: the aggregates these are matched against are
 * proto-free by design (profile/aggregates.ts is pure and testable without the
 * protobuf runtime), so the comparison is between numbers on both sides.
 */
const HOLDER_ORDER: number[] = [
  RegisterHolder.SELF,
  RegisterHolder.SPOUSE_PARTNER,
  RegisterHolder.DEPENDENT_CHILDREN,
  RegisterHolder.UNSPECIFIED,
];

/**
 * The holder donut's icons. UNSPECIFIED is deliberately absent — "Holder not
 * stated" is the absence of a fact and the set holds no glyph for one, for the
 * same reason HolderBadge draws none.
 */
const HOLDER_SEGMENT_ICON: Partial<Record<number, PoliticsIconName>> = {
  [RegisterHolder.SELF]: HOLDER_ICON.self,
  [RegisterHolder.SPOUSE_PARTNER]: HOLDER_ICON.spouse,
  [RegisterHolder.DEPENDENT_CHILDREN]: HOLDER_ICON.dependent,
};

function shortDate(date?: Date): string {
  return date
    ? date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
    : "";
}

/**
 * `2025-04-17` -> `17 Apr 2025`, or "" when the AEC return omitted the date.
 *
 * Formatted in UTC on purpose: `new Date("2025-04-17")` is UTC midnight, and
 * formatting that in a timezone behind UTC prints the previous day — a donation
 * dated one day off its return is a wrong fact, not a cosmetic one.
 */
function isoDayLabel(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return "";
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function sumItems(counts: ProfileItemCount[], itemNos: number[]): number {
  return counts
    .filter((count) => itemNos.includes(count.itemNo))
    .reduce((sum, count) => sum + count.currentCount, 0);
}

/**
 * A date-shaped tile, matching the count tiles beside it.
 *
 * Takes a formatted, non-empty string. There is no placeholder state: the
 * caller renders no tile at all when it holds no date, because a dash here
 * would still be a tile claiming to report when the register last moved.
 */
function AsAtTile({ value, label }: { value: string; label: string }) {
  return (
    <article className="rounded-lg border bg-card p-4">
      <div className="text-base font-semibold tabular-nums text-foreground">{value}</div>
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
  const [data, explorer, distinctive, funding] = await Promise.all([
    getPolitician(slug),
    getPoliticianExplorerProfile(slug),
    getDistinctiveHoldings(slug),
    // The AEC funding layer. A SEPARATE SOURCE from everything else on this
    // page: the registers record what is held and never how much, while these
    // are lodged funding figures published under CC BY 4.0. Most members have no
    // linked return and the section then renders nothing at all.
    getPoliticianFunding(slug),
  ]);
  const p = data?.politician;
  if (!p) notFound();

  // SILENCE IS A CLAIM ON THIS SECTION, so an outage may not be baked as one.
  // `undefined` is the retry helper's exhausted signal — the request did not
  // answer — and the funding section renders NOTHING in that case, which on this
  // feature's own doctrine reads as "no return names this member". This page is
  // cached for 24h, so a regen that caught a cold rpc would publish that absence
  // about a named person for a day. A populated-but-empty response is a genuine
  // answer and is left alone.
  if (funding === undefined) bailOnEmptyRender();

  // Slugs are minted server-side and never derived by the client. If the request
  // used an old one, redirect to the canonical.
  if (data?.canonicalSlug && data.canonicalSlug !== slug) {
    permanentRedirect(`/politicians/${data.canonicalSlug}`);
  }

  const url = `https://shorted.com.au/politicians/${p.slug}`;
  const role = p.chamber === "senate" ? `Senator for ${p.stateCode}` : `Member for ${p.division}`;
  const interests = data?.interests ?? [];
  const rows = buildDeclarationRows(interests);
  /*
   * ONE PREDICATE FOR EVERY SENTENCE ON THIS PAGE THAT EXPLAINS AN EMPTY
   * REGISTER: the CoverageNote, the empty declarations section, and the two
   * LLMMeta strings. It reads the ROWS THIS PAGE RENDERS rather than the
   * listed/property counts the index gate uses, so the explanation and the
   * thing it explains can never disagree.
   */
  const senateRegisterGap = p.chamber === "senate" && rows.length === 0;
  const asAt = interests
    .map((i) => toDate(i.declaredFrom))
    .filter((d): d is Date => !!d)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  // The rpc's aggregates where they exist, the rows' own where they do not. ONE
  // condition drives all three: a half-explorer/half-fallback tile row would put
  // two different denominators on the same screen. That condition is "the rpc
  // reported a nonzero current count", NOT "the rpc returned rows" — it always
  // returns fourteen, zeroed or not, so a length check let a cold materialized
  // view publish "0 entries currently declared" above a populated table. See
  // profile/aggregates.ts.
  const { itemCounts, holderCounts, undatedCount } = selectProfileAggregates(
    explorer,
    interests,
  );
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
  // then the newest date this member's own entries carry. NEVER a refresh clock
  // — the analytics response's as-at is when the rollup was last rebuilt, and
  // threading it in here printed TODAY on most profiles. Undefined when we hold
  // neither date, and the tile is then omitted rather than invented.
  const lastUpdated = registerLastUpdated(latestChange?.changedOn, asAt);

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
    .map((count) => ({
      label: count.label,
      count: count.currentCount,
      // The register category's own icon, so the donut legend, the category
      // tabs beneath it and every declaration row agree on what a category
      // looks like.
      icon: registerItemIcon(count.itemNo),
    }));
  const holderSegments = HOLDER_ORDER.map((holder) => ({
    label: (HOLDER_FILTER[holder] ?? HOLDER_FILTER[RegisterHolder.UNSPECIFIED]!).label,
    count: holderCounts.find((count) => count.holder === holder)?.currentCount ?? 0,
    // Only the three holder kinds have a figure; "Holder not stated" is the
    // absence of one and the set holds no glyph for it, deliberately — see
    // HolderBadge. That segment renders its label alone.
    icon: HOLDER_SEGMENT_ICON[holder],
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
      {/*
        THE MACHINE-READABLE TWINS OF THE META DESCRIPTION, BRANCHED ON THE SAME
        PREDICATE.

        `generateMetadata` already refuses to describe a senator's page as
        "register of interests entries" — there are none, because we have read
        none. These two strings said it anyway, to the audience least able to
        check: an LLM reading `dataSource` as "Registers of Members' and
        Senators' Interests" is being told this page is sourced from a document
        we have never opened, and `description` as "Register of interests
        entries for X" asserts entries exist. Same predicate, same branch, so
        the two can never drift apart.
      */}
      <LLMMeta
        title={`${p.displayName} — declared interests`}
        description={
          senateRegisterGap
            ? `${p.displayName}, ${role}. ${SENATE_REGISTER_GAP}`
            : `Register of interests entries for ${p.displayName}, ${role}.`
        }
        url={url}
        dataSource={
          senateRegisterGap
            ? "AEC Transparency Register (funding) and the Parliamentary Handbook (identity); the Register of Senators' Interests has not been read into this site"
            : "Registers of Members' and Senators' Interests, Parliament of Australia"
        }
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
          {/* The senate branch is inside CoverageNote and replaces the House
              parliament sentences outright — see compliance.tsx. It reads the
              ROW COUNTS, not the chamber alone, so a dual-chamber senator with
              House rows keeps the ordinary note. */}
          <CoverageNote
            extracted={data?.extractedParliaments ?? []}
            partial={data?.partialParliaments ?? []}
            pending={data?.pendingParliaments ?? []}
            chamber={p.chamber}
            /* The ROWS THIS PAGE ACTUALLY RENDERS, not the listed/property
               counts the index gate uses. A register row that resolved to
               neither a company nor a suburb is still a register row, and the
               note and the section below it must agree about whether this page
               has one. */
            hasRegisterEntries={rows.length > 0}
            /* The terms are what make each parliament claim CHAMBER-AWARE. A
               dual-chamber member's House parliaments keep the "read in full"
               sentences; the ones they spent in the Senate leave them, because
               no Senate volume has been read for any parliament. */
            terms={(data?.terms ?? []).map((term) => ({
              parliament: term.parliament,
              chamber: term.chamber,
            }))}
          />

          <section className="space-y-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <CountTile count={currentEntryCount} label="entries currently declared" />
              <CountTile count={currentCompanyCount} label="ASX-listed companies named" />
              <CountTile count={realEstateCount} label="real-estate declarations" />
              <CountTile count={liabilityCount} label="liabilities entries" />
              <CountTile count={giftTravelCount} label="gifts and sponsored travel" />
              {/* Omitted, not blanked: a date tile with a dash in it still
                  asserts we know when this register last moved. */}
              {lastUpdated ? (
                <AsAtTile value={shortDate(lastUpdated)} label="register last updated" />
              ) : null}
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
              {/*
                A CHART OF ZEROES IS AN ABSENCE CLAIM WITH A PICTURE ON IT.

                `rows.length > 0` is the new outer gate, and it is here because
                of the senators. The timeline rpc returns a month bucket per
                month in the window whether or not anything is in it, so a
                senator with no register rows rendered "Entries declared over
                time" as a flat zero line across five years — a drawn statement
                that this named person declared nothing in any of them, sitting
                directly beneath a note explaining that we have not read their
                register at all.

                It costs nothing elsewhere: a profile with no rows has an empty
                donut and an empty chart whatever chamber it belongs to.
              */}
              {rows.length > 0 && (currentEntryCount > 0 || timelinePoints.length > 0) ? (
                <section className="space-y-6">
                  <h2 className={sectionTitle}>
                    <SectionIcon name="coverage" />
                    What is declared, at a glance
                  </h2>
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
                      <SectionIcon name="timeline" size="sm" />
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

              <section className="space-y-4 border-t border-border/60 pt-8">
                <h2 className={sectionTitle}>
                  <SectionIcon name="other-interests" />
                  Declared interests
                </h2>
                {rows.length === 0 ? (
                  /*
                   * TWO DIFFERENT ABSENCES, AND THEY MAY NOT SHARE A SENTENCE.
                   *
                   * For a member, "nothing appears ... for the parliaments
                   * listed above" is true and bounded: the note above names the
                   * parliaments we read, and the sentence is scoped to them.
                   *
                   * For a senator it would be a lie by omission. We have read
                   * NONE of the Senate's tabled volumes, so there are no
                   * parliaments listed above to scope the sentence to, and the
                   * only honest thing to say is that the document is unread and
                   * the gap is ours.
                   */
                  <p className="text-sm text-muted-foreground">
                    {senateRegisterGap
                      ? SENATE_REGISTER_GAP
                      : "Nothing appears in this member’s register entries for the parliaments listed above."}
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

              {/*
                A DIFFERENT SOURCE, AND A DIFFERENT RULE. Everything above is
                the register of interests, which records what is held and never
                how much. This is the AEC Transparency Register, whose whole
                purpose is to state amounts and which is published under CC BY
                4.0 — so amounts appear here and only here.

                It renders NOTHING unless a return actually names this member:
                no heading, no frame, no "no returns" line. Party money is never
                on the response behind it, and most parliamentarians never lodge
                an annual return, so an empty frame would read as "received
                nothing" — an absence claim the corpus cannot support.
              */}
              <FundingReturns
                annualReturns={(funding?.annualReturns ?? []).map((row) => ({
                  financialYear: row.financialYear,
                  financialYearEnd: row.financialYearEnd,
                  returnType: row.returnType,
                  chamber: row.chamber,
                  memberName: row.memberName,
                  totalDonationsCents: Number(row.totalDonationsCents),
                  donorCount: row.donorCount,
                  sourceUrl: row.sourceUrl,
                }))}
                candidateReturns={(funding?.candidateReturns ?? []).map((row) => ({
                  event: row.event,
                  eventYear: row.eventYear,
                  returnType: row.returnType,
                  candidateName: row.candidateName,
                  partyName: row.partyName,
                  electorateName: row.electorateName,
                  electorateState: row.electorateState,
                  nilReturn: row.nilReturn,
                  amendmentNo: row.amendmentNo,
                  totalGiftCents: Number(row.totalGiftCents),
                  donorCount: row.donorCount,
                  expenditureCents: Number(row.expenditureCents),
                  discretionaryCents: Number(row.discretionaryCents),
                  donations: (row.donations ?? []).map((donation) => ({
                    donorName: donation.donorName,
                    // Formatted server-side so the server and hydrated renders
                    // cannot differ.
                    dateLabel: isoDayLabel(donation.donationDate),
                    amountCents: Number(donation.amountCents),
                  })),
                  eventReturnCount: row.eventReturnCount,
                  eventItemisedReturnCount: row.eventItemisedReturnCount,
                  sourceUrl: row.sourceUrl,
                }))}
                coverageNote={funding?.coverageNote}
                attributionNote={funding?.attributionNote}
                censoringNote={funding?.censoringNote}
              />

              {(data?.representedSuburbs?.length ?? 0) > 0 && (
                <section className="space-y-2 border-t border-border/60 pt-8">
                  <h2 className={sectionTitle}>
                    <SectionIcon name="electorate" />
                    Suburbs represented
                  </h2>
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
              {/*
                Renders NOTHING when the rpc is unavailable or the member has no
                sole-declared company. The rail is a fact about the register's
                other 318 members, not a claim about this one, so an empty frame
                or a "none" line would be an absence claim the data cannot carry.
              */}
              <DistinctiveHoldings
                holdings={(distinctive?.holdings ?? []).map((holding) => ({
                  stockCode: holding.stockCode,
                  companyName: holding.companyName,
                  industry: holding.industry,
                  holder: holding.holder,
                  corpusDeclarerCount: holding.corpusDeclarerCount,
                  shortPercent: holding.shortPercent,
                }))}
                disclosureNote={distinctive?.disclosureNote}
                moreCount={distinctive?.moreCount ?? 0}
              />
              <section className="rounded-lg border bg-card p-4">
                <h2 className={sectionTitle}>
                  <SectionIcon name="compare" />
                  Compare
                </h2>
                {/* "Parliamentarian", not "member": this rail is on senator
                    profiles now, and the comparison itself already uses the
                    word that covers both chambers. */}
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                  Put this parliamentarian&rsquo;s declared entries side by side with
                  another&rsquo;s. Counts only, both sides the same.
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
