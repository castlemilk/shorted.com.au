import type { Metadata } from "next";
import { Suspense, type ReactNode } from "react";
import { toDate } from "@/lib/politics/timestamp";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import {
  CaveatNote,
  CoverageNote,
  DeclaredEntity,
  PartyChip,
  SourceLine,
} from "@/components/politicians/compliance";
import { PoliticianExplorer } from "@/components/politicians/politician-explorer";
// The component only. NEVER import a plain value from a "use client" module
// here: a server component receives a client-reference proxy for it and throws
// "Cannot access <prop>.valueOf on the server" during the prerender.
import { PoliticianRegisterTable } from "@/components/politicians/politician-register-table";
import { RegisterHeatmap } from "@/components/politicians/register-heatmap";
import { AboutThisData } from "@/components/politicians/explorer/about-this-data";
import { CountDonut } from "@/components/politicians/explorer/count-donut";
import { CountTile } from "@/components/politicians/explorer/count-tile";
import {
  getParliamentOverview,
  getPoliticianAnalytics,
  getRegisterExplorer,
  listPoliticianStocks,
  listPoliticians,
  listRegisterChanges,
} from "~/app/actions/getPoliticians";
import { loadPoliticianTable } from "~/app/actions/politicianTable";
import { bailOnEmptyRender } from "~/app/actions/config";
import { pageTitle, sectionTitle, eyebrow, lede } from "@/lib/typography";
import { partyLabel } from "@/lib/politics/party-palette";
import { REGISTER_ITEMS } from "@/lib/politics/register-items";
import { SENATE_REGISTER_GAP_CORPUS } from "@/lib/politics/register-coverage";
import { registerItemIcon } from "@/lib/politics/register-item-icons";
import { PoliticsIcon, SectionIcon } from "@/components/politicians/politics-icon";
import { REPORT_ERROR_EMAIL } from "@/lib/report-error";
import { RegisterChangeKind } from "~/gen/shorts/v1alpha1/politicians_pb";

const URL = "https://shorted.com.au/politicians";
const TITLE = "Parliament's Portfolio — What Federal MPs and Senators Declare";
const DESCRIPTION =
  "What Australian federal parliamentarians declare in the Registers of Members' and Senators' Interests: ASX-listed companies, real estate by suburb, and how those declarations change over time. The registers record what is held, never quantity or value.";

/**
 * The APH landing page for the House register.
 *
 * The Senate tables its volumes on a different page, so ONE link cannot serve
 * both registers; this is the entry point APH itself publishes, and every
 * individual row on a profile deep-links the exact document it came from
 * (SourceDocLink). We link, never rehost — §3.1's posture publishes extracted
 * facts, not the source artefacts.
 */
const REGISTER_SOURCE_URL =
  "https://www.aph.gov.au/Senators_and_Members/Members/Register";

/**
 * The licence the API states for this corpus (registerLicence, politicians.go).
 * The fallback is the same claim in the same words the CaveatNote uses, so the
 * band never renders a blank licence line when the rpc is unavailable.
 */
const REGISTER_LICENCE_FALLBACK =
  "Parliamentary material; © Commonwealth of Australia";

const REPORT_ERROR_HREF = `mailto:${REPORT_ERROR_EMAIL}?subject=${encodeURIComponent(
  "Register of Interests data — politicians hub",
)}`;

/**
 * Rows in the first page of the register table.
 *
 * Well inside the handler's clamp (default 50, max 200) and deliberately below
 * its default: this page prerenders the first page into the HTML, and 25 rows
 * of portraits and sparklines is the point where the payload stops paying for
 * itself. Everything past it is fetched on demand.
 */
const HUB_TABLE_PAGE_SIZE = 25;

// Static ISR. The register corpus changes only when the APH crawl re-ingests, so
// the server fetches are KV-cached (getPoliticians.ts) and this route prerenders.
// We deliberately do NOT read searchParams here — doing so silently forces
// dynamic rendering and kills the ISR. Every interactive control on this page
// (the Algolia island, the register table) therefore drives itself client-side.
export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "register of members interests",
    "register of senators interests",
    "MP shareholdings australia",
    "politician stock holdings",
    "parliament declared interests",
    "MP property declarations",
  ],
  alternates: { canonical: URL },
  openGraph: {
    type: "website",
    url: URL,
    title: TITLE,
    description: DESCRIPTION,
    siteName: "Shorted",
    locale: "en_AU",
  },
  twitter: { card: "summary_large_image", creator: "@shorted___" },
};

/** Shown while the client explorer hydrates, so the section is never a blank gap. */
function ExplorerFallback() {
  return (
    <div className="space-y-3">
      <div className="h-12 rounded-md border bg-muted/30" />
      <p className="text-xs text-muted-foreground">Loading search…</p>
    </div>
  );
}

function StatusCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <article className="space-y-2 rounded-lg border bg-card p-4">
      <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </article>
  );
}

function plural(count: number, singular: string, plural_: string): string {
  return count === 1 ? singular : plural_;
}

/** A movement, stated as a signed count. No colour, no arrow, no verdict. */
function signed(value: number): string {
  return value < 0 ? `−${Math.abs(value)}` : `+${value}`;
}

/**
 * The first value that is actually a count.
 *
 * Not `??`: a ZERO from the first source has to fall through to the second one.
 * The overview and the explorer answer the same question from different views,
 * and either can be cold while the other is healthy.
 */
function firstPositive(...values: (number | undefined)[]): number {
  for (const value of values) {
    if (typeof value === "number" && value > 0) return value;
  }
  return 0;
}

function shortDate(date?: Date): string {
  return date
    ? date.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" })
    : "";
}

export default async function PoliticiansPage() {
  const [overview, explorer, mostHeld, people, senators, analytics, table, changes] =
    await Promise.all([
      getParliamentOverview(),
      getRegisterExplorer(),
      listPoliticianStocks(12, true),
      // 500, NOT 400. The identity layer minted 171 senators (495 rows against
      // the 324 this list was sized for), and a roll that silently stops at 400
      // drops 95 named people out of the only server-rendered index of them.
      // 500 is the handler's own clamp ceiling.
      listPoliticians("", "", "", "", 500, 0),
      // ONE ROW, FOR ITS TOTAL. The chamber split is a coverage fact the hub has
      // to state — the Senate volumes are unread — and stating it needs a count
      // that comes from the data rather than a number typed into the copy.
      listPoliticians("senate", "", "", "", 1, 0),
      getPoliticianAnalytics(14, false),
      loadPoliticianTable({ limit: HUB_TABLE_PAGE_SIZE }),
      listRegisterChanges(8, 0),
    ]);

  // The overview rpc predates the explorer rollups and does not depend on
  // migration 000104, so it stays the liveness gate: if the explorer view is
  // missing or cold the hub still renders everything it had before, rather than
  // bailing the whole page.
  const politicianCount = firstPositive(overview?.politicianCount, explorer?.politicianCount);
  if (politicianCount === 0) bailOnEmptyRender();

  // THE OVERVIEW'S AS-AT FIRST, and it is not interchangeable with the
  // explorer's. `overview.as_at` is the newest LODGEMENT date in the corpus —
  // the pinned semantics the SourceLine and the "About this data" band both
  // publish ("Register of Members' and Senators' Interests, as at DATE"). The
  // explorer aggregates a materialized view, so its as-at has read as the
  // refresh clock, and preferring it printed the day of the last rebuild as the
  // day parliament last filed something. It stays as the fallback for a cold
  // overview, never as the first choice.
  const asAt = toDate(overview?.asAt ?? explorer?.asAt);
  const asAtIso = asAt ? asAt.toISOString().slice(0, 10) : "";
  const statedLicence = explorer?.sourceLicence?.trim() ?? "";
  const licence = statedLicence.length > 0 ? statedLicence : REGISTER_LICENCE_FALLBACK;

  // The explorer aggregates are only rendered when they carry a category total.
  // A zeroed response (kill switch, cold materialised view, un-applied
  // migration) would otherwise publish "0 declared entries" — an absence claim
  // about every member of parliament at once.
  const itemCounts = explorer?.itemCounts ?? [];
  const hasExplorer = itemCounts.some((item) => item.currentCount > 0);

  const maxCount = Math.max(1, ...(mostHeld?.stocks ?? []).map((s) => s.politicianCount));
  const maxStatePeople = Math.max(1, ...(analytics?.states ?? []).map((s) => s.people));

  const tiles: { count: number; label: string }[] = hasExplorer
    ? [
        { count: politicianCount, label: "parliamentarians" },
        { count: explorer?.currentDeclaredCount ?? 0, label: "entries currently declared" },
        {
          count: explorer?.distinctCompanyCount ?? 0,
          label: "ASX-listed companies declared",
        },
        // LABELLING: item-3 register ENTRIES, never "properties". Roughly a
        // third of item-3 rows merge two or more addresses into one entry, so
        // this is a floor on what was declared.
        { count: explorer?.propertyCount ?? 0, label: "declared real-estate entries" },
        { count: explorer?.giftsTravelCount ?? 0, label: "gifts & sponsored travel entries" },
        { count: explorer?.liabilityCount ?? 0, label: "declared liabilities entries" },
      ]
    : [
        { count: politicianCount, label: "parliamentarians" },
        { count: overview?.declaredRowCount ?? 0, label: "declared entries" },
        { count: overview?.resolvedListedCount ?? 0, label: "ASX-listed companies" },
        { count: overview?.resolvedSuburbCount ?? 0, label: "suburbs with declared property" },
      ];

  const extracted = explorer?.extractedParliaments ?? [];
  const partial = explorer?.partialParliaments ?? [];
  const pending = explorer?.pendingParliaments ?? [];
  const industryTrends = explorer?.industryTrends ?? [];
  const maxIndustryCount = Math.max(1, ...industryTrends.map((t) => t.currentCount));

  const donutSegments = itemCounts
    .map((item) => ({
      // The register's own taxonomy, short form. registerItem() carries the
      // form's legal wording as a tooltip elsewhere; a donut legend needs the
      // short label.
      label: REGISTER_ITEMS[item.itemNo]?.label ?? item.itemLabel,
      count: item.currentCount,
      // The category's own icon, so the legend reads the same way the
      // declaration rows and the activity feed do. `undefined` for an item
      // number the taxonomy does not hold — the legend then shows the label
      // alone rather than a stand-in glyph for a category we cannot name.
      icon: registerItemIcon(item.itemNo),
    }))
    .filter((segment) => segment.count > 0)
    .sort((a, b) => b.count - a.count);

  // The Senate half of the roll, from the rpc's own total rather than counted
  // over `roll` — the roll is one page, and a count taken from it would shrink
  // the moment the page size changed.
  const senatorCount = senators?.total ?? 0;

  const roll = people?.politicians ?? [];
  const stateOptions = [...new Set(roll.map((p) => p.stateCode).filter(Boolean))].sort();
  const partyOptions = [...new Set(roll.map((p) => p.partyAb).filter(Boolean))].sort((a, b) =>
    partyLabel(a).localeCompare(partyLabel(b)),
  );

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: TITLE,
    description: DESCRIPTION,
    url: URL,
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    spatialCoverage: "Australia",
    // NO `license` HERE, DELIBERATELY.
    //
    // This block declares `creator: Shorted`, so a `license` on it is a
    // machine-readable claim about OUR terms for OUR dataset. It used to point
    // at aph.gov.au's copyright page — which is CC BY-NC-ND 4.0. That asserted
    // a NonCommercial-NoDerivs grant we have no standing to make, on a paid
    // product, and it contradicts the posture the subsystem is actually built
    // on: §3.1 publishes extracted FACTS with attribution, and facts carry no
    // licence to grant.
    //
    // The source relationship belongs in `sourceOrganization` (below) and in
    // the visible SourceLine, both of which say where the data came from
    // without claiming terms over it.
    sourceOrganization: [
      {
        "@type": "GovernmentOrganization",
        name: "Parliament of Australia",
        url: "https://www.aph.gov.au",
      },
    ],
    variableMeasured: [
      { "@type": "PropertyValue", name: "Members declaring an interest in a listed company" },
      { "@type": "PropertyValue", name: "Members declaring real estate in a suburb" },
      { "@type": "PropertyValue", name: "Register entries currently declared, by category" },
    ],
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="Registers of Members' and Senators' Interests, Parliament of Australia"
        dataFrequency="continuous during sitting periods"
        keywords={["register of interests", "MP shareholdings", "declared interests"]}
      />
      <DashboardLayout>
        <div className="mx-auto max-w-6xl space-y-12 px-4 py-8">
          <header className="space-y-3">
            <p className={eyebrow}>Influence layer</p>
            <h1 className={pageTitle}>Parliament&rsquo;s Portfolio</h1>
            <p className={lede}>
              What federal parliamentarians declare in the Registers of Members&rsquo; and
              Senators&rsquo; Interests — the companies, the suburbs, and how the declarations
              change. The registers record <strong>what</strong> is held; they do not record
              quantity or value.
            </p>
          </header>

          {hasExplorer ? (
            <section className="grid gap-3 md:grid-cols-3">
              <StatusCard title="Coverage">
                {extracted.length + partial.length + pending.length > 0 ? (
                  <CoverageNote extracted={extracted} partial={partial} pending={pending} />
                ) : (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Register documents published by the Parliament of Australia for parliaments{" "}
                    {overview?.firstParliament ?? explorer?.firstParliament}–
                    {overview?.lastParliament ?? explorer?.lastParliament}.
                  </p>
                )}
              </StatusCard>

              <StatusCard title="Recent activity">
                <p className="text-sm leading-relaxed">
                  <strong className="tabular-nums">{explorer?.changes7d ?? 0}</strong>{" "}
                  {plural(explorer?.changes7d ?? 0, "entry", "entries")} entered or left the
                  registers in the last 7 days, across{" "}
                  <strong className="tabular-nums">{explorer?.membersChanged7d ?? 0}</strong>{" "}
                  {plural(explorer?.membersChanged7d ?? 0, "member", "members")}.
                </p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Over 30 days: {explorer?.changes30d ?? 0}{" "}
                  {plural(explorer?.changes30d ?? 0, "entry", "entries")} across{" "}
                  {explorer?.membersChanged30d ?? 0}{" "}
                  {plural(explorer?.membersChanged30d ?? 0, "member", "members")}. A change is an
                  entry appearing in or leaving the register — not a transaction.
                </p>
                <Link
                  href="/politicians/changes"
                  className="inline-block text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                >
                  Every addition and removal →
                </Link>
              </StatusCard>

              <StatusCard title="Category movement">
                {industryTrends.length > 0 ? (
                  <>
                    <ul className="space-y-1 text-sm">
                      {industryTrends.slice(0, 3).map((trend) => (
                        <li key={trend.industry} className="flex items-baseline justify-between gap-2">
                          <span className="truncate">{trend.industry}</span>
                          <span className="shrink-0 tabular-nums text-[11px] text-muted-foreground">
                            {trend.count90dAgo} → {trend.currentCount} (
                            {signed(trend.currentCount - trend.count90dAgo)})
                          </span>
                        </li>
                      ))}
                    </ul>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Distinct ASX-listed companies declared in each industry, now and 90 days
                      ago. Dated entries only: an entry whose start date the register does not
                      state is excluded from both sides.
                    </p>
                  </>
                ) : (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    No dated movement to compare over the last 90 days.
                  </p>
                )}
              </StatusCard>
            </section>
          ) : null}

          <section className="space-y-2">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {tiles.map((tile) => (
                <CountTile key={tile.label} count={tile.count} label={tile.label} />
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Counts of register entries and of the things they name — never an amount. A
              real-estate entry can list more than one address, so that figure is a floor on what
              was declared, not a tally of properties.
            </p>
            {/*
              THE TILE ROW SPANS TWO DIFFERENT LAYERS, AND THE SPLIT IS STATED
              RATHER THAN QUIETLY AVERAGED.

              The first tile counts the IDENTITY layer — everyone we hold a
              person for, both chambers, which is what the roll, the search
              index and the funding layer are all sized by. Every other tile
              counts the REGISTER. Those two numbers used to be the same and are
              not any more: senator identity was minted from the Parliamentary
              Handbook while the Senate's tabled register volumes remain
              unread, so a "parliamentarians" figure beside "entries currently
              declared" now implies register coverage for people whose register
              we have never opened.

              The alternative was to shrink the first tile back to the register's
              own population, which would have hidden the senators from the one
              place the hub states its size — so the tile keeps the honest
              denominator and this line carries the split.
            */}
            {senatorCount > 0 ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                The first tile counts everyone we hold an identity for, in both chambers;{" "}
                <strong className="tabular-nums">{senatorCount}</strong> of them are senators. The
                remaining tiles count the register. {SENATE_REGISTER_GAP_CORPUS}
              </p>
            ) : null}
          </section>

          <section className="space-y-3">
            {/*
              ONE ACCENT PER SECTION, from the `ui` group where the section is
              about the chamber rather than about a register category. The icon
              is decorative and the heading text is unchanged — rule 2 treats an
              icon beside a named person as copy, so an accent may only restate
              what the heading already says.
            */}
            <h2 className={sectionTitle}>
              <SectionIcon name="parliament" />
              Every parliamentarian, and what they declare
            </h2>
            <p className="text-sm text-muted-foreground">
              Sorted by the number of entries currently declared. Filter by chamber, state, party
              or register category; the first page is in the HTML, and every other page is
              fetched on demand.
            </p>
            {/*
              `min-w-0` ON BOTH GRID ITEMS, AND IT IS LOAD-BEARING. A grid item
              defaults to `min-width:auto`, which means "at least as wide as my
              content". The register table below sets `min-w-[52rem]` (832 px)
              inside an `overflow-x-auto` wrapper, and that 832 px propagated
              straight up through this item — so at 375 px the scroller never
              engaged and the WHOLE PAGE scrolled sideways instead, dragging the
              sticky header with it (measured +511 px of document overflow, with
              4 of the 7 table columns and 2 of the 4 filters off-screen).
              `minmax(0,1fr)` on the template fixes the same thing, but only at
              `lg:` — which is exactly the breakpoint where the bug did not
              matter. These two classes are what make the table scroll instead of
              the document.
            */}
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_17rem]">
              <div className="min-w-0 space-y-3">
                <PoliticianRegisterTable
                  initialPage={table}
                  loadPage={loadPoliticianTable}
                  stateOptions={stateOptions}
                  partyOptions={partyOptions}
                />
                {/*
                  The citation sits with the data that names people, which is
                  what editorial-copy.test.ts's hub-section exclusion relies on:
                  the table island carries no SourceLine of its own because this
                  one covers it. The "About this data" band at the foot is the
                  dataset-level statement, not a substitute for this.
                */}
                <SourceLine asAt={asAt} surface="politicians hub" />
              </div>

              <aside className="min-w-0 space-y-8">
                {donutSegments.length > 0 ? (
                  <CountDonut
                    segments={donutSegments}
                    centerLabel="entries"
                    title="What is declared, by category"
                  />
                ) : null}

                {industryTrends.length > 0 ? (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">
                      <SectionIcon name="directorships" size="sm" />
                      Industry movement
                    </h3>
                    <ul className="space-y-1.5">
                      {industryTrends.slice(0, 8).map((trend) => (
                        <li key={trend.industry} className="space-y-0.5">
                          <div className="flex items-baseline justify-between gap-2 text-[11px]">
                            <span className="truncate">{trend.industry}</span>
                            <span className="shrink-0 tabular-nums text-muted-foreground">
                              {trend.currentCount} ({signed(trend.currentCount - trend.count90dAgo)}
                              )
                            </span>
                          </div>
                          {/* CSS width, not a chart library: this is a count. */}
                          <div
                            className="h-2 rounded-sm bg-amber-500/70"
                            style={{
                              width: `${(trend.currentCount / maxIndustryCount) * 100}%`,
                            }}
                            aria-hidden
                          />
                        </li>
                      ))}
                    </ul>
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      Distinct ASX-listed companies declared in each industry, with the change
                      against 90 days ago. Dated entries only.
                    </p>
                  </div>
                ) : null}

                {(changes?.events?.length ?? 0) > 0 ? (
                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">
                      <SectionIcon name="source-document" size="sm" />
                      Recent filings
                    </h3>
                    <ul className="space-y-2.5">
                      {(changes?.events ?? []).slice(0, 8).map((event, index) => (
                        <li key={`${event.politician?.slug ?? "member"}-${index}`}>
                          <div className="flex flex-wrap items-baseline gap-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                            <span className="tabular-nums normal-case">
                              {shortDate(toDate(event.changedOn))}
                            </span>
                            {/*
                              THE TWO ICONS ARE THE SAME WEIGHT AND THE SAME
                              INK. A page sits into a folder or slides out of
                              one; neither is coloured, and neither is a tick or
                              a cross. A removal can mean an asset was disposed
                              of, a declaration was corrected, or the member left
                              parliament — the icon may not pick one, and it may
                              not read as the bad half of a good/bad pair.
                            */}
                            <span className="inline-flex items-center gap-1">
                              <PoliticsIcon
                                name={
                                  event.kind === RegisterChangeKind.ADDED
                                    ? "entry-added"
                                    : "entry-removed"
                                }
                                size={12}
                              />
                              {event.kind === RegisterChangeKind.ADDED ? "added" : "removed"}
                            </span>
                          </div>
                          {event.politician ? (
                            <Link
                              href={`/politicians/${event.politician.slug}`}
                              prefetch={false}
                              className="inline-block py-1 text-xs hover:underline"
                            >
                              {event.politician.displayName}
                            </Link>
                          ) : null}
                          <div className="truncate text-[11px]">
                            <DeclaredEntity
                              declaredText={event.declaredText}
                              stockCode={event.stockCode}
                              companyName={event.companyName}
                              entityKind={event.entityKind}
                            />
                          </div>
                        </li>
                      ))}
                    </ul>
                    <Link
                      href="/politicians/changes"
                      className="inline-block text-[11px] text-muted-foreground underline decoration-dotted hover:text-foreground"
                    >
                      Every addition and removal →
                    </Link>
                  </div>
                ) : null}

                {/*
                  THE ONE CROSS-LINK TO THE FUNDING LAYER, and its copy does the
                  work of keeping the two apart. The register above records what
                  a member holds and never how much; the AEC Transparency
                  Register records what PARTIES declared receiving, and money
                  given to a party is not money given to a member. The card says
                  so rather than leaving a reader to assume the link continues
                  the same subject.
                */}
                <div className="space-y-2 rounded-lg border bg-card p-4">
                  <h3 className="text-sm font-medium">
                    <SectionIcon name="donation-receipt" size="sm" />
                    Party funding and donations
                  </h3>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    A separate source: what registered parties declared receiving each financial
                    year, who the payers were, and which of them are ASX-listed companies, as
                    lodged with the AEC. Party money is not attributable to any individual
                    member.
                  </p>
                  <Link
                    href="/politicians/donations"
                    className="inline-block text-[11px] underline decoration-dotted hover:text-foreground"
                  >
                    Open the funding explorer →
                  </Link>
                </div>

                <div className="space-y-2 rounded-lg border bg-card p-4">
                  <h3 className="text-sm font-medium">
                    <SectionIcon name="compare" size="sm" />
                    Compare two members
                  </h3>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Put two members side by side: what each declares, what both declare, and where
                    they differ. Counts only, symmetrically — no score and no ranking between
                    them.
                  </p>
                  <Link
                    href="/politicians/compare"
                    className="inline-block text-[11px] underline decoration-dotted hover:text-foreground"
                  >
                    Open the comparison →
                  </Link>
                </div>
              </aside>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className={sectionTitle}>
              <SectionIcon name="shareholdings" />
              Most-declared ASX-listed companies
            </h2>
            <p className="text-sm text-muted-foreground">
              Counted by <strong>number of members declaring an interest</strong> — not by any
              amount. The bars compare people, nothing more.
            </p>
            <table className="w-full text-sm">
              <caption className="sr-only">
                Number of federal parliamentarians declaring an interest in each ASX-listed company.
                A count of declarations, not an amount invested.
              </caption>
              <thead className="sr-only">
                <tr>
                  <th>Company</th>
                  <th>Members declaring</th>
                </tr>
              </thead>
              <tbody>
                {(mostHeld?.stocks ?? []).map((s) => (
                  <tr key={s.stockCode} className="border-b last:border-0">
                    <th scope="row" className="w-40 py-1.5 pr-3 text-left font-normal">
                      <Link href={`/shorts/${s.stockCode}`} className="hover:underline">
                        <span className="font-medium">{s.stockCode}</span>
                      </Link>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {s.companyName}
                      </span>
                    </th>
                    <td className="py-1.5">
                      <div className="flex items-center gap-2">
                        {/* CSS width, not a chart library: this is a count, and a
                            plain bar keeps it accessible and bundle-free. */}
                        <div
                          className="h-3 rounded-sm bg-amber-500/70"
                          style={{ width: `${(s.politicianCount / maxCount) * 100}%` }}
                          aria-hidden
                        />
                        <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                          {s.politicianCount}
                        </span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="space-y-3">
            <h2 className={sectionTitle}>Find a parliamentarian</h2>
            {/* "COVERED" IS THE WORD THAT HAD TO GO. On a page about the
                register, "N members and senators covered" reads as "we hold the
                register for N people" — untrue of 171 senators. The count is
                the searchable roll, and the sentence now says only that. */}
            <p className="text-sm text-muted-foreground">
              {people?.total ?? 0} members and senators are searchable here. Search by name,
              electorate, or by what they declare — a company or a suburb.
            </p>
            {senatorCount > 0 ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Senators are searchable by name, state and party like everyone else.{" "}
                {SENATE_REGISTER_GAP_CORPUS}
              </p>
            ) : null}
            {/*
              The explorer reads its query state from the URL, which needs
              useSearchParams — and that needs a Suspense boundary in a
              statically rendered route. Reading searchParams on THIS server
              component instead would silently flip the whole page to dynamic and
              kill the ISR, which is the trap /price-drops already paid for.
            */}
            <Suspense fallback={<ExplorerFallback />}>
              <PoliticianExplorer />
            </Suspense>
          </section>

          <section className="space-y-3">
            <h2 className={sectionTitle}>
              <SectionIcon name="directorships" />
              Which parties declare interests in which industries
            </h2>
            <p className="text-sm text-muted-foreground">
              Each cell counts <strong>members</strong>, not holdings and not money — a member who
              declares four banks is one member. The registers record no quantity or value, so
              nothing here can be weighted by size.
            </p>
            <RegisterHeatmap
              cells={(analytics?.cells ?? []).map((c) => ({
                partyAb: c.partyAb,
                industry: c.industry,
                people: c.people,
                companies: c.companies,
              }))}
              industries={(analytics?.industries ?? []).map((i) => ({
                industry: i.industry,
                people: i.people,
                companies: i.companies,
              }))}
              parties={(analytics?.parties ?? []).map((p) => ({
                partyAb: p.partyAb,
                people: p.people,
              }))}
              industriesOmitted={analytics?.industriesOmitted ?? 0}
            />
          </section>

          {(analytics?.states.length ?? 0) > 0 ? (
            <section className="space-y-3">
              <h2 className={sectionTitle}>
                <SectionIcon name="electorate" />
                Members declaring company interests, by state
              </h2>
              <p className="text-sm text-muted-foreground">
                Where the members who declare a company interest sit — a count of people, and a
                function of how many seats a state has as much as anything else.
              </p>
              <table className="w-full max-w-xl text-sm">
                <caption className="sr-only">
                  Number of federal parliamentarians from each state or territory declaring an
                  interest in an ASX-listed company.
                </caption>
                <thead className="sr-only">
                  <tr>
                    <th>State</th>
                    <th>Members declaring</th>
                    <th>Distinct companies</th>
                  </tr>
                </thead>
                <tbody>
                  {(analytics?.states ?? []).map((s) => (
                    <tr key={s.stateCode} className="border-b last:border-0">
                      <th scope="row" className="w-16 py-1.5 text-left font-normal">
                        {s.stateCode}
                      </th>
                      <td className="py-1.5">
                        <div className="flex items-center gap-2">
                          <div
                            className="h-3 rounded-sm bg-amber-500/70"
                            style={{ width: `${(s.people / maxStatePeople) * 100}%` }}
                            aria-hidden
                          />
                          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                            {s.people}
                          </span>
                        </div>
                      </td>
                      <td className="w-32 py-1.5 text-right text-[11px] text-muted-foreground">
                        {s.companies} companies
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          <section className="space-y-3">
            <h2 className={sectionTitle}>
              <SectionIcon name="coverage" />
              Every parliamentarian
            </h2>
            {/*
              The complete roll, server-rendered. The table above pages 25 at a
              time and the explorer is a client island, so neither puts every
              profile URL in the HTML; this does. <details> keeps them in the DOM
              while collapsed — the same trick the profile page uses for suburbs.
            */}
            {/* THE COVERAGE CONTEXT HAS TO BE REACHABLE FROM THE ROLL ITSELF.
                Every senator's card below shows "0 listed / 0 property", which
                is the data — but a column of zeroes with nothing beside it is
                read as a finding about 171 named people. */}
            {senatorCount > 0 ? (
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {SENATE_REGISTER_GAP_CORPUS}
              </p>
            ) : null}
            <details className="text-sm">
              <summary className="cursor-pointer text-muted-foreground">
                {people?.total ?? 0} members and senators
              </summary>
              <ul className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {/*
                  `prefetch={false}` — this is the single biggest source of the
                  hub's load-time request storm. 400 member links in the HTML is
                  400 candidate RSC prefetches (~23 KB each); the measured first
                  load pulled 1,179 KB across 56 requests before the reader had
                  clicked anything. A roll is a directory, not a set of likely
                  next steps.
                */}
                {roll.map((p) => (
                  <li key={p.slug} className="rounded-md border p-2.5">
                    <Link
                      href={`/politicians/${p.slug}`}
                      prefetch={false}
                      className="inline-block py-1 text-sm hover:underline"
                    >
                      {p.displayName}
                    </Link>
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <PartyChip partyAb={p.partyAb} />
                      {p.division ? (
                        <span className="text-[11px] text-muted-foreground">{p.division}</span>
                      ) : null}
                      {p.stateCode ? (
                        <span className="text-[11px] text-muted-foreground">{p.stateCode}</span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex gap-3 text-[11px] text-muted-foreground">
                      <span>{p.declaredListedCount} listed</span>
                      <span>{p.declaredPropertyCount} property</span>
                    </div>
                  </li>
                ))}
              </ul>
            </details>
          </section>

          <section className="space-y-3">
            <h2 className={sectionTitle}>Where else this appears</h2>
            <ul className="space-y-1 text-sm">
              <li>
                <Link href="/politicians/short-interest" className="hover:underline">
                  Declared interests in companies carrying short interest →
                </Link>
              </li>
              <li>
                <Link href="/politicians/changes" className="hover:underline">
                  Recent register additions and removals →
                </Link>
              </li>
              <li>
                <Link href="/politicians/compare" className="hover:underline">
                  Compare two members side by side →
                </Link>
              </li>
            </ul>
          </section>

          <div className="space-y-6">
            <AboutThisData
              sourceHref={REGISTER_SOURCE_URL}
              licence={licence}
              asAt={asAtIso}
              updateCadence="Re-extracted as new register documents are published — continuously during sitting periods."
              methodologyHref="#method-and-caveats"
              reportErrorHref={REPORT_ERROR_HREF}
            />
            <div id="method-and-caveats" className="scroll-mt-24">
              <CaveatNote />
            </div>
          </div>
        </div>
      </DashboardLayout>
    </>
  );
}
