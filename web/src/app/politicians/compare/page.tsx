import type { Metadata } from "next";
import { Suspense } from "react";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { CaveatNote, SourceLine } from "@/components/politicians/compliance";
import { ComparePanel } from "./compare-panel-loader";
import { eyebrow, lede, pageTitle } from "@/lib/typography";

const URL = "https://shorted.com.au/politicians/compare";
const TITLE = "Compare declared interests — Parliament's Portfolio";
const DESCRIPTION =
  "Put two federal parliamentarians' entries in the Registers of Members' and Senators' Interests side by side: register categories, the ASX-listed companies that appear in both sets of declarations, and the ones that appear in only one. Counts of declared entries only — the registers record no quantity and no value.";

/**
 * Static ISR, and it stays that way because this page reads NO `searchParams`.
 *
 * The `?a=` / `?b=` pair is the whole point of the route and it is read
 * CLIENT-side by the panel below (`useSearchParams`, under the Suspense
 * boundary). Reading it here instead would silently flip the route to dynamic —
 * the trap /price-drops paid for and /politicians documents.
 *
 * There is no server fetch: the comparison depends entirely on the two members
 * a reader picks, so the shell is pure chrome and nothing can bake a stale or
 * empty payload into the route cache.
 */
export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "compare politician declared interests",
    "register of members interests",
    "register of senators interests",
    "MP declared shareholdings",
    "parliament declared interests",
  ],
  // Canonical without the query, deliberately: every `?a=&b=` pairing is the
  // same page with a different selection, and letting each one become its own
  // indexable URL would publish thousands of near-identical pages about named
  // individuals.
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

/* No JSON-LD here on purpose. The page publishes no dataset of its own — it
   renders a selection a reader makes — and a Dataset block describing it would
   be a machine-readable claim we would then have to keep true. */

function PanelFallback() {
  return (
    <div className="space-y-3">
      <div className="h-11 rounded-md border bg-muted/30" />
      <p className="text-xs text-muted-foreground">Loading the picker…</p>
    </div>
  );
}

export default function ComparePoliticiansPage() {
  return (
    <DashboardLayout>
      <div className="mx-auto max-w-6xl space-y-10 px-4 py-8">
        <header className="space-y-3">
          <p className={eyebrow}>Influence layer</p>
          <h1 className={pageTitle}>Compare declared interests</h1>
          <p className={lede}>
            Two federal parliamentarians, their register entries beside each
            other. Everything on this page is a count of entries on a form: the
            Registers of Members&rsquo; and Senators&rsquo; Interests record{" "}
            <strong>what</strong> is held and record no quantity and no value, so
            there is nothing here to total and nothing to rank.
          </p>
          <p className="text-sm text-muted-foreground">
            Back to{" "}
            <Link
              href="/politicians"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              Parliament&rsquo;s Portfolio →
            </Link>
          </p>
        </header>

        {/*
          Suspense is required, not cosmetic: the panel reads `?a=` and `?b=`
          with useSearchParams, which suspends on a statically rendered route,
          and the dynamic import's own `loading` fallback does not satisfy it.
        */}
        <Suspense fallback={<PanelFallback />}>
          <ComparePanel />
        </Suspense>

        <footer className="space-y-3 border-t pt-6">
          <SourceLine surface="politician comparison" />
          <CaveatNote />
        </footer>
      </div>
    </DashboardLayout>
  );
}
