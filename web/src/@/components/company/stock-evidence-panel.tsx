import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import {
  buildEvidenceChannels,
  type EvidenceChannel,
} from "~/@/lib/industry-intelligence";
import { type IndustryIntelligenceSnapshot } from "~/@/lib/industry-intelligence-snapshot";

/** Preferred headline metric per channel (kept in sync with the industry view). */
const PRIMARY_METRIC_BY_KIND: Record<string, string> = {
  tax_environment: "tax_payable",
  public_money: "contract_value",
  emissions: "scope_1_2_emissions",
  trade_exposure: "export_value",
  policy_footprint: "declared_receipt_value",
};

function formatMetricValue(value: number, unit: string): string {
  if (unit === "AUD") {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(value);
  }
  const compact = new Intl.NumberFormat("en-AU", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
  if (unit.toLowerCase().startsWith("t ")) return `${compact} t`;
  return compact;
}

interface ChannelHeadline {
  kind: string;
  label: string;
  value: string;
  detail: string;
  asOf: string | null;
}

function headlineForChannel(channel: EvidenceChannel): ChannelHeadline | null {
  const preferred = PRIMARY_METRIC_BY_KIND[channel.kind];
  const buckets = channel.timeBuckets.filter(
    (bucket) => !preferred || bucket.metricKey === preferred,
  );
  const series = buckets.length > 0 ? buckets : channel.timeBuckets;
  const latest = series.at(-1);
  if (!latest) return null;
  const total = series.reduce((sum, bucket) => sum + bucket.totalValue, 0);
  return {
    kind: channel.kind,
    label: channel.label,
    value: formatMetricValue(latest.totalValue, latest.unit),
    detail:
      series.length > 1
        ? `FY ${latest.bucketLabel} · ${formatMetricValue(total, latest.unit)} across ${series.length} years`
        : `FY ${latest.bucketLabel} · ${latest.recordCount} record${latest.recordCount === 1 ? "" : "s"}`,
    asOf: channel.latestAsOf,
  };
}

/**
 * Per-stock public-source evidence dossier: one compressed row per live
 * channel (this stock's own records only — exact ABN/name matched), each
 * deep-linking into the industry intelligence workspace. Renders nothing when
 * no evidence exists for the stock (the no-fake-data contract).
 *
 * Pure presentational view — the SNAPSHOT is fetched by the caller. On the
 * stock page that caller is StockEvidencePanelClient, which only fetches
 * after the session resolves as authenticated, so dossier data never ships
 * in the shared ISR page payload.
 */
export function StockEvidencePanelView({
  snapshot,
  industry,
  industrySlug,
}: {
  snapshot: IndustryIntelligenceSnapshot | null;
  industry?: string | null;
  industrySlug?: string | null;
}) {
  if (!snapshot) return null;

  const channels = buildEvidenceChannels(snapshot);
  const headlines = channels
    .map(headlineForChannel)
    .filter((headline): headline is ChannelHeadline => headline !== null);
  if (headlines.length === 0) return null;

  const intelligenceHref = industrySlug
    ? `/industry-intelligence?industry=${industrySlug}`
    : "/industry-intelligence";

  return (
    <section
      aria-labelledby="stock-evidence-heading"
      data-testid="stock-evidence-panel"
      className="min-w-0 rounded-lg border border-border/60 bg-card/80 shadow-amber-sm"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border/60 px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
            Public money · tax · registers
          </p>
          <h2
            id="stock-evidence-heading"
            className="mt-0.5 text-lg font-semibold tracking-tight"
          >
            Public-source evidence
          </h2>
        </div>
        <Link
          href={intelligenceHref}
          prefetch={false}
          className="inline-flex min-h-10 items-center gap-1 text-sm text-primary hover:underline"
        >
          {industry ? `${industry} intelligence` : "Industry intelligence"}
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
        </Link>
      </div>

      <ul className="divide-y divide-border/40">
        {headlines.map((headline) => (
          <li key={headline.kind}>
            <Link
              href={
                industrySlug
                  ? `/industry-intelligence?industry=${industrySlug}&view=channel-${headline.kind}`
                  : "/industry-intelligence"
              }
              prefetch={false}
              className="group flex min-h-12 flex-wrap items-baseline gap-x-4 gap-y-0.5 px-5 py-3 transition-colors hover:bg-muted/50"
            >
              <span className="w-36 shrink-0 text-sm font-medium group-hover:text-primary">
                {headline.label}
              </span>
              <span className="font-mono text-sm font-semibold tabular-nums">
                {headline.value}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                {headline.detail}
              </span>
              {headline.asOf ? (
                <span className="hidden shrink-0 font-mono text-xs tabular-nums text-muted-foreground sm:inline">
                  as at {headline.asOf}
                </span>
              ) : null}
            </Link>
          </li>
        ))}
      </ul>

      <p className="border-t border-border/60 px-5 py-2.5 text-xs leading-5 text-muted-foreground text-pretty">
        Imported from published registers for exact-matched entities only.
        Figures are shown beside their source and never imply causation.
      </p>
    </section>
  );
}
