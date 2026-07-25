import type { Metadata } from "next";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import {
  CaveatNote,
  ShortInterestCaveat,
  SourceLine,
} from "@/components/politicians/compliance";
import { listShortInterestOverlap } from "~/app/actions/getPoliticians";
import { bailOnEmptyRender } from "~/app/actions/config";
import { pageTitle, eyebrow, lede } from "@/lib/typography";

const URL = "https://shorted.com.au/politicians/short-interest";
const TITLE = "Declared Interests in Heavily Shorted ASX Companies";
const DESCRIPTION =
  "Companies carrying short interest that federal parliamentarians declare an interest in. Short interest is a market-wide ASIC figure for the company and says nothing about any member's holding.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", creator: "@shorted___" },
};

export default async function ShortInterestOverlapPage() {
  const data = await listShortInterestOverlap(2, 60);
  if (!data || data.overlaps.length === 0) bailOnEmptyRender();

  return (
    <>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="Registers of Members'/Senators' Interests (APH); short positions (ASIC)"
        dataFrequency="daily short data; register continuous during sitting periods"
      />
      <DashboardLayout>
        <div className="mx-auto max-w-4xl space-y-8 px-4 py-8">
          <header className="space-y-3">
            <p className={eyebrow}>
              <Link href="/politicians" className="hover:underline">
                Parliament&rsquo;s Portfolio
              </Link>
            </p>
            <h1 className={pageTitle}>Declared interests in shorted companies</h1>
            <p className={lede}>
              Companies carrying short interest that federal parliamentarians declare an interest in.
              Two separate public facts, shown together.
            </p>
          </header>

          {/* The caveat comes from the API response, so the wording lives in one
              place and cannot drift from what the data means. */}
          <ShortInterestCaveat note={data?.disclosureNote} />

          <table className="w-full text-sm">
            <caption className="sr-only">
              ASX-listed companies with short interest that federal parliamentarians declare an
              interest in. The short percentage describes the company, not any holding.
            </caption>
            <thead>
              <tr className="border-b text-left text-xs text-muted-foreground">
                <th scope="col" className="py-2">Company</th>
                <th scope="col" className="py-2 text-right">Company short interest</th>
                <th scope="col" className="py-2 text-right">Members declaring</th>
              </tr>
            </thead>
            <tbody>
              {(data?.overlaps ?? []).map((o) => (
                <tr key={o.stockCode} className="border-b last:border-0">
                  <th scope="row" className="py-2 text-left font-normal">
                    <Link href={`/shorts/${o.stockCode}`} className="hover:underline">
                      <span className="font-medium">{o.stockCode}</span>
                    </Link>
                    <span className="block truncate text-[11px] text-muted-foreground">
                      {o.companyName}
                    </span>
                  </th>
                  <td className="py-2 text-right tabular-nums">{o.shortPercent.toFixed(2)}%</td>
                  <td className="py-2 text-right tabular-nums text-muted-foreground">
                    {o.politicianCount}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <footer className="space-y-3 border-t pt-6">
            <SourceLine surface="short-interest overlap" />
            <CaveatNote />
          </footer>
        </div>
      </DashboardLayout>
    </>
  );
}
