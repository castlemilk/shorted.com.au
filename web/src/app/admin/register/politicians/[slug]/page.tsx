import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import Container from "@/components/ui/container";
import { PoliticianCrm } from "@/components/admin/register-review/politician-crm";
import { pageTitle, eyebrow } from "@/lib/typography";
import { getPoliticianProfile } from "~/app/actions/admin/politicianCrm";
import { requireAdmin } from "~/server/admin";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Politician record",
  robots: { index: false, follow: false },
};

export default async function PoliticianCrmDetail({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  await requireAdmin();
  const { slug } = await params;
  const profile = await getPoliticianProfile(slug);
  if (!profile?.profile) notFound();

  return (
    <Container>
      <div className="space-y-6 py-8">
        <header className="space-y-1">
          <p className={eyebrow}>
            <Link href="/admin/register/politicians" className="hover:underline">
              Politician records
            </Link>
          </p>
          <h1 className={pageTitle}>{profile.profile.displayName}</h1>
        </header>

        <PoliticianCrm initial={profile} />
      </div>
    </Container>
  );
}
