import type { Metadata } from "next";

import Container from "@/components/ui/container";
import { SecuritiesReview } from "@/components/admin/register-review/securities-review";
import { pageTitle, eyebrow, lede } from "@/lib/typography";
import {
  getCoverageStats,
  listSecurityQueue,
} from "~/app/actions/admin/registerReview";
import { requireAdmin } from "~/server/admin";

// An operator surface over live editorial data. Never cached, never prerendered:
// two reviewers must not be handed the same candidate because one of them was
// served a page built an hour ago.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export const metadata: Metadata = {
  title: "Register security review",
  robots: { index: false, follow: false },
};

export default async function SecuritiesReviewPage() {
  // Gate the ROUTE as well as each action. Neither is sufficient alone: the
  // route gate stops a page render, the action gates stop a direct POST.
  await requireAdmin();

  const [page, coverage] = await Promise.all([
    listSecurityQueue(25, 0, false),
    getCoverageStats(),
  ]);

  return (
    <Container>
      <div className="space-y-6 py-8">
        <header className="space-y-2">
          <p className={eyebrow}>Register of Interests · operator console</p>
          <h1 className={pageTitle}>Security review</h1>
          <p className={lede}>
            Undecided declared names, biggest fan-out first. Every decision writes one row to{" "}
            <code className="font-mono text-xs">register_security_aliases</code> and changes
            nothing that is published until the next{" "}
            <code className="font-mono text-xs">register-resolve</code> runs.
          </p>
        </header>

        <SecuritiesReview initialPage={page} initialCoverage={coverage} />
      </div>
    </Container>
  );
}
