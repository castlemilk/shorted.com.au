"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { StockLogo } from "@/components/reports/stock-logo";
import { EconomyIcon } from "./economy-icon";
import { listStateCompaniesClient } from "~/app/actions/client/getEconomyClient";
import type { StateSlug } from "@/lib/economy/map-metrics";

/**
 * Dossier "Operating here" list — top companies by exposure-weighted market
 * cap for a state, from ListStateCompanies (mv_company_state_exposure).
 *
 * Logos: StockLogo (reports) — plain-img/letter-avatar chip that is safe for
 * arbitrary GCS logo hosts (next/image throws on un-allowlisted hosts).
 * Renders nothing when the state has no rows.
 */
export function StateCompanies({ state }: { state: StateSlug }) {
  const { data } = useQuery({
    queryKey: ["economy-state-companies", state],
    staleTime: 60 * 60 * 1000,
    queryFn: () => listStateCompaniesClient(state, 8),
  });
  const companies = data?.companies ?? [];
  if (!companies.length) return null;

  const abbr = state.toUpperCase();

  return (
    <div data-testid="state-companies" className="min-w-0">
      <h4 className="flex items-center gap-1.5 font-serif text-sm font-semibold">
        <EconomyIcon name="company-footprint" size={18} />
        Operating here
      </h4>
      <ul className="mt-2 space-y-1.5">
        {companies.map((c) => (
          <li key={c.stockCode} className="flex items-center gap-2 text-xs">
            <StockLogo code={c.stockCode} logoUrl={c.logoUrl || undefined} size="sm" />
            <Link
              href={`/shorts/${c.stockCode}`}
              className="min-w-0 flex-1 truncate hover:underline"
              title={c.basis || undefined}
            >
              <span className="font-mono font-semibold">{c.stockCode}</span>
              <span className="ml-1.5 text-muted-foreground">{c.companyName}</span>
            </Link>
            {c.source === "hq_fallback" ? (
              <span
                className="rounded-sm border border-border px-1 py-px font-mono text-[10px] text-muted-foreground"
                title="Attributed to head-office state (no operations estimate)"
              >
                HQ
              </span>
            ) : null}
            <span className="rounded-sm bg-primary/10 px-1 py-px font-mono text-[10px] tabular-nums text-primary">
              {abbr} {Math.round(c.weight * 100)}%
            </span>
            {c.industry ? (
              <span className="hidden w-24 truncate text-right text-[10px] text-muted-foreground sm:inline">
                {c.industry}
              </span>
            ) : null}
            {c.shortPercent > 0 ? (
              <span className="rounded-sm bg-red-500/10 px-1 py-px font-mono text-[10px] tabular-nums text-red-600">
                {c.shortPercent.toFixed(1)}% short
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[10px] text-muted-foreground">
        Operations-weighted, AI-estimated from company disclosures · HQ-based where noted
      </p>
    </div>
  );
}
