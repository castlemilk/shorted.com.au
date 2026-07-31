import type { Metadata } from "next";
import Link from "next/link";

import Container from "@/components/ui/container";
import { Badge } from "@/components/ui/badge";
import { PoliticianAvatar } from "@/components/politicians/politician-avatar";
import { pageTitle, eyebrow, lede } from "@/lib/typography";
import { listPoliticianProfiles } from "~/app/actions/admin/politicianCrm";
import { requireAdmin } from "~/server/admin";

// Operator surface over live editorial data. Never cached, never prerendered.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Politician records",
  robots: { index: false, follow: false },
};

export default async function PoliticianCrmIndex() {
  await requireAdmin();
  const { profiles, total, duplicateCount } = await listPoliticianProfiles("", 200, 0, false);

  return (
    <Container>
      <div className="space-y-6 py-8">
        <header className="space-y-2">
          <p className={eyebrow}>Register of Interests · operator console</p>
          <h1 className={pageTitle}>Politician records</h1>
          <p className={lede}>
            {total} records. Duplicates sort first — a person published twice shows only part of
            their declared history on each page, which is a wrong fact about a named individual.
          </p>
        </header>

        {duplicateCount > 0 ? (
          <p className="rounded-lg border p-3 text-sm">
            <span className="font-medium">{duplicateCount}</span> records share an APH PHID with
            another. Each pair is one person.
          </p>
        ) : null}

        <ul className="divide-y rounded-lg border">
          {profiles.map((p) => (
            <li key={p.slug}>
              <Link
                href={`/admin/register/politicians/${p.slug}`}
                className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40"
              >
                <PoliticianAvatar
                  displayName={p.displayName}
                  partyAb={p.partyAb}
                  size="sm"
                  // The index deliberately shows the monogram rather than the
                  // portrait: without the licence fields loaded we cannot
                  // attribute an image, and an unattributed CC BY-SA render is
                  // a breach. The detail page loads them and shows the face.
                />
                <span className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{p.displayName}</span>
                  <span className="block text-[11px] text-muted-foreground">
                    {p.chamber === "senate" ? p.stateCode : p.division}
                    {p.partyAb ? ` · ${p.partyAb}` : ""} · {p.statementCount} statements
                    {p.aphPhid ? ` · PHID ${p.aphPhid}` : " · no PHID"}
                  </span>
                </span>
                {p.curatedFieldCount > 0 ? (
                  <Badge variant="outline" className="text-[10px]">
                    {p.curatedFieldCount} curated
                  </Badge>
                ) : null}
                {p.hasDuplicate ? (
                  <Badge variant="secondary" className="text-[10px]">
                    duplicate
                  </Badge>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </Container>
  );
}
