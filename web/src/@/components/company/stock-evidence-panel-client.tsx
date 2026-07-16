"use client";

import { useQuery } from "@tanstack/react-query";
import { useSession } from "next-auth/react";

import { IntelLockCard } from "~/@/components/ui/intel-lock";
import { StockEvidencePanelView } from "./stock-evidence-panel";

/**
 * Session-gated wrapper for the per-stock evidence dossier on the (ISR,
 * session-agnostic) stock page.
 *
 * Signed-out visitors see the lock card — and ONLY the lock card: the
 * snapshot query is disabled until the session resolves as authenticated,
 * so the gated data is fetched client-side per-user and never appears in
 * the cached page payload.
 */
export function StockEvidencePanelClient({
  stockCode,
  industry,
  industrySlug,
}: {
  stockCode: string;
  industry?: string | null;
  industrySlug?: string | null;
}) {
  const { status } = useSession();

  const { data: snapshot } = useQuery({
    queryKey: ["stock-evidence-snapshot", stockCode],
    // The fetcher's import chain touches @connectrpc/connect, whose module
    // init crashes the SSR pass (see CLAUDE.md) — this component SSRs now
    // (it sits in the SSR'd tabs shell), so the import must be deferred to
    // the browser-side query execution.
    queryFn: async () => {
      const { fetchIndustryIntelligenceSnapshotClient } = await import(
        "~/app/actions/client/getIndustryIntelligenceClient"
      );
      return fetchIndustryIntelligenceSnapshotClient("", 50, stockCode);
    },
    enabled: status === "authenticated",
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });

  if (status !== "authenticated") {
    return (
      <IntelLockCard
        title={`${stockCode} intelligence dossier`}
        description="Public-source evidence for this company, with industry drill-up links."
        bullets={[
          "Tax paid and taxable income records",
          "Government contracts and public money",
          "Emissions and trade exposure",
          "Political donations and lobbying links",
        ]}
        callbackUrl={`/shorts/${stockCode}`}
        ctaLabel="Sign in to unlock the dossier"
      />
    );
  }

  return (
    <StockEvidencePanelView
      snapshot={snapshot ?? null}
      industry={industry}
      industrySlug={industrySlug}
    />
  );
}
