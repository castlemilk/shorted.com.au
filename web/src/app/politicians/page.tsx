import type { Metadata } from "next";
import { toDate } from "@/lib/politics/timestamp";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import { CaveatNote, PartyChip, SourceLine } from "@/components/politicians/compliance";
import {
  getParliamentOverview,
  listPoliticianStocks,
  listPoliticians,
} from "~/app/actions/getPoliticians";
import { bailOnEmptyRender } from "~/app/actions/config";
import { pageTitle, sectionTitle, eyebrow, lede } from "@/lib/typography";

const URL = "https://shorted.com.au/politicians";
const TITLE = "Parliament's Portfolio — What Federal MPs and Senators Declare";
const DESCRIPTION =
  "What Australian federal parliamentarians declare in the Registers of Members' and Senators' Interests: ASX-listed companies, real estate by suburb, and how those declarations change over time. The registers record what is held, never quantity or value.";

// Static ISR. The register corpus changes only when the APH crawl re-ingests, so
// the server fetches are KV-cached (getPoliticians.ts) and this route prerenders.
// We deliberately do NOT read searchParams here — doing so silently forces
// dynamic rendering and kills the ISR.
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

function BigStat({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
      {hint ? <div className="mt-1 text-[11px] text-muted-foreground/80">{hint}</div> : null}
    </div>
  );
}

export default async function PoliticiansPage() {
  const [overview, mostHeld, people] = await Promise.all([
    getParliamentOverview(),
    listPoliticianStocks(12, true),
    listPoliticians("", "", "", "", 200, 0),
  ]);

  const hasData = (overview?.politicianCount ?? 0) > 0;
  if (!hasData) bailOnEmptyRender();

  const asAt = toDate(overview?.asAt);
  const maxCount = Math.max(1, ...(mostHeld?.stocks ?? []).map((s) => s.politicianCount));

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: TITLE,
    description: DESCRIPTION,
    url: URL,
    isAccessibleForFree: true,
    creator: { "@type": "Organization", name: "Shorted", url: "https://shorted.com.au" },
    spatialCoverage: "Australia",
    license: "https://www.aph.gov.au/Help/Disclaimer_Privacy_Copyright",
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

          <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <BigStat
              value={String(overview?.politicianCount ?? 0)}
              label="parliamentarians"
              hint={`parliaments ${overview?.firstParliament ?? ""}–${overview?.lastParliament ?? ""}`}
            />
            <BigStat value={String(overview?.declaredRowCount ?? 0)} label="declared entries" />
            <BigStat
              value={String(overview?.resolvedListedCount ?? 0)}
              label="ASX-listed companies"
              hint="matched to a listing"
            />
            <BigStat
              value={String(overview?.resolvedSuburbCount ?? 0)}
              label="suburbs"
              hint="with declared property"
            />
          </section>

          <section className="space-y-3">
            <h2 className={sectionTitle}>Most-declared ASX-listed companies</h2>
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
            <h2 className={sectionTitle}>Parliamentarians</h2>
            <p className="text-sm text-muted-foreground">
              {people?.total ?? 0} members and senators covered. Counts are of declared entries that
              matched a listing or a suburb.
            </p>
            <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {(people?.politicians ?? []).slice(0, 60).map((p) => (
                <li key={p.slug} className="rounded-md border p-2.5">
                  <Link href={`/politicians/${p.slug}`} className="text-sm hover:underline">
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
            </ul>
          </section>

          <footer className="space-y-3 border-t pt-6">
            <SourceLine asAt={asAt} surface="politicians hub" />
            <CaveatNote />
          </footer>
        </div>
      </DashboardLayout>
    </>
  );
}
