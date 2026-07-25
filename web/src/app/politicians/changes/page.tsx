import type { Metadata } from "next";
import { toDate } from "@/lib/politics/timestamp";
import Link from "next/link";

import { DashboardLayout } from "~/@/components/layouts/dashboard-layout";
import { LLMMeta } from "@/components/seo/llm-meta";
import {
  CaveatNote,
  DeclaredEntity,
  HolderBadge,
  PartyChip,
  SourceLine,
} from "@/components/politicians/compliance";
import { listRegisterChanges } from "~/app/actions/getPoliticians";
import { bailOnEmptyRender } from "~/app/actions/config";
import { pageTitle, eyebrow, lede } from "@/lib/typography";
import { RegisterChangeKind } from "~/gen/shorts/v1alpha1/politicians_pb";

const URL = "https://shorted.com.au/politicians/changes";
const TITLE = "Register of Interests — Recent Additions and Removals";
const DESCRIPTION =
  "Entries added to or removed from the Registers of Members' and Senators' Interests, with the date each change appeared. A removal is not a transaction.";

export const revalidate = 3600;

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: URL },
  openGraph: { type: "website", url: URL, title: TITLE, description: DESCRIPTION, siteName: "Shorted", locale: "en_AU" },
  twitter: { card: "summary_large_image", creator: "@shorted___" },
};

function fmt(d?: Date): string {
  return d ? d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : "";
}

export default async function RegisterChangesPage() {
  const data = await listRegisterChanges(150, 0);
  if (!data || data.events.length === 0) bailOnEmptyRender();

  return (
    <>
      <LLMMeta
        title={TITLE}
        description={DESCRIPTION}
        url={URL}
        dataSource="Registers of Members' and Senators' Interests, Parliament of Australia"
        dataFrequency="continuous during sitting periods"
      />
      <DashboardLayout>
        <div className="mx-auto max-w-4xl space-y-8 px-4 py-8">
          <header className="space-y-3">
            <p className={eyebrow}>
              <Link href="/politicians" className="hover:underline">
                Parliament&rsquo;s Portfolio
              </Link>
            </p>
            <h1 className={pageTitle}>Register additions and removals</h1>
            <p className={lede}>
              Entries that entered or left the registers, newest first. These are register events,
              not transactions — an entry can disappear because an asset was disposed of, because a
              declaration was corrected, or because the member left parliament.
            </p>
          </header>

          <ul className="divide-y">
            {(data?.events ?? []).map((e, idx) => {
              const p = e.politician;
              const added = e.kind === RegisterChangeKind.ADDED;
              return (
                <li key={`${p?.slug}-${idx}`} className="flex flex-col gap-1 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="w-24 shrink-0 text-[11px] tabular-nums text-muted-foreground">
                      {fmt(toDate(e.changedOn))}
                    </span>
                    <span
                      className={
                        added
                          ? "text-[10px] uppercase tracking-wide text-emerald-600/80"
                          : "text-[10px] uppercase tracking-wide text-muted-foreground"
                      }
                    >
                      {added ? "added" : "removed"}
                    </span>
                    {p ? (
                      <Link href={`/politicians/${p.slug}`} className="text-sm hover:underline">
                        {p.displayName}
                      </Link>
                    ) : null}
                    <HolderBadge holder={e.holder} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 pl-24">
                    <DeclaredEntity
                      declaredText={e.declaredText}
                      stockCode={e.stockCode}
                      companyName={e.companyName}
                    />
                    <PartyChip partyAb={p?.partyAb} />
                    <span className="text-[10px] text-muted-foreground">{e.itemLabel}</span>
                  </div>
                </li>
              );
            })}
          </ul>

          <footer className="space-y-3 border-t pt-6">
            <SourceLine surface="register changes" />
            <CaveatNote />
          </footer>
        </div>
      </DashboardLayout>
    </>
  );
}
