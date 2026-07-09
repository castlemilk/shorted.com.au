"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Download, Flag, Lock } from "lucide-react";

import { Button } from "~/@/components/ui/button";
import { SegmentedToggle } from "~/@/components/features/housing/charts/chart-ui";
import { useSubscription } from "~/@/hooks/use-subscription";
import { downloadCSV } from "~/@/lib/csv-export";
import type {
  EvidenceChannel,
  IndustryEvidenceTimeBucketInput,
} from "~/@/lib/industry-intelligence";
import {
  FyBucketBarChart,
  type FyBucketDatum,
  type FyBucketFormat,
} from "./charts/fy-bucket-bar-chart";

const REPORT_ERROR_EMAIL = "support@shorted.com.au";

/** Preferred headline metric per channel; falls back to the busiest metric. */
const PRIMARY_METRIC_BY_KIND: Record<string, string> = {
  tax_environment: "tax_payable",
  public_money: "contract_value",
  emissions: "scope_1_2_emissions",
  trade_exposure: "export_value",
  policy_footprint: "declared_receipt_value",
};

/** Compact toggle labels; the full metric label stays in charts and tooltips. */
const METRIC_TOGGLE_LABELS: Record<string, string> = {
  tax_payable: "Tax payable",
  taxable_income: "Taxable income",
  total_income: "Total income",
  export_value: "Exports",
  import_value: "Imports",
  declared_receipt_value: "Receipts",
  declared_donation_value: "Donations",
  registered_lobbyist_engagements: "Lobbyists",
  registered_foreign_principals: "FITS",
  contract_value: "Contracts",
  scope_1_2_emissions: "Scope 1+2",
};

function toggleLabelFor(series: MetricSeries): string {
  return METRIC_TOGGLE_LABELS[series.metricKey] ?? series.metricLabel;
}

function formatForUnit(unit: string): FyBucketFormat {
  if (unit === "AUD") return "aud";
  if (unit.toLowerCase().startsWith("t ")) return "tonnes";
  return "count";
}

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

interface MetricSeries {
  metricKey: string;
  metricLabel: string;
  unit: string;
  buckets: IndustryEvidenceTimeBucketInput[];
}

function metricSeriesForChannel(channel: EvidenceChannel): MetricSeries[] {
  const byMetric = new Map<string, MetricSeries>();
  for (const bucket of channel.timeBuckets) {
    let series = byMetric.get(bucket.metricKey);
    if (!series) {
      series = {
        metricKey: bucket.metricKey,
        metricLabel: bucket.metricLabel,
        unit: bucket.unit,
        buckets: [],
      };
      byMetric.set(bucket.metricKey, series);
    }
    series.buckets.push(bucket);
  }
  const preferred = PRIMARY_METRIC_BY_KIND[channel.kind];
  return [...byMetric.values()].sort((a, b) => {
    if (a.metricKey === preferred) return -1;
    if (b.metricKey === preferred) return 1;
    return b.buckets.length - a.buckets.length;
  });
}

/** Tax-only derivation: entities reporting income with no tax payable row. */
function noTaxPayableCount(channel: EvidenceChannel): number | null {
  if (channel.kind !== "tax_environment") return null;
  const latestFor = (metricKey: string) =>
    channel.timeBuckets
      .filter((b) => b.metricKey === metricKey)
      .at(-1);
  const income = latestFor("total_income");
  const payable = latestFor("tax_payable");
  if (!income) return null;
  const payableEntities =
    payable && payable.bucketLabel === income.bucketLabel
      ? payable.entityCount
      : 0;
  return Math.max(income.entityCount - payableEntities, 0);
}

export function IndustryChannelDashboards({
  industryName,
  industrySlug,
  channels,
}: {
  industryName: string;
  industrySlug: string;
  channels: EvidenceChannel[];
}) {
  if (channels.length === 0) return null;

  return (
    <section className="min-w-0 space-y-5" data-testid="industry-evidence-dashboards">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
            Evidence dashboard
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-balance">
            {industryName} public-source signals
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-muted-foreground text-pretty">
            Imported, dated primary-source facts for exact-matched ASX entities.
            Figures are shown beside their register and never imply causation.
          </p>
        </div>
        <EvidenceExportButton
          industryName={industryName}
          industrySlug={industrySlug}
          channels={channels}
        />
      </div>

      <div className="grid min-w-0 gap-5 lg:grid-cols-2">
        {channels.map((channel) => (
          <ChannelCard key={channel.kind} channel={channel} />
        ))}
      </div>
    </section>
  );
}

function ChannelCard({ channel }: { channel: EvidenceChannel }) {
  const series = useMemo(() => metricSeriesForChannel(channel), [channel]);
  const [metricKey, setMetricKey] = useState(series[0]?.metricKey ?? "");
  const active =
    series.find((s) => s.metricKey === metricKey) ?? series[0] ?? null;
  const noTax = noTaxPayableCount(channel);

  // Cap the chart to the most recent financial years so long registers (AEC
  // reaches back to 1998-99) keep readable tick labels; the all-time tile
  // still covers the full history.
  const chartData: FyBucketDatum[] = (active?.buckets ?? [])
    .slice(-16)
    .map((bucket) => ({
      label: bucket.bucketLabel,
      value: bucket.totalValue,
      recordCount: bucket.recordCount,
      entityCount: bucket.entityCount,
    }));
  const latest = active?.buckets.at(-1) ?? null;
  const allTimeTotal = (active?.buckets ?? []).reduce(
    (sum, bucket) => sum + bucket.totalValue,
    0,
  );
  const entityTotals = channel.entityTotals
    .filter((total) => !active || total.metricKey === active.metricKey)
    .slice(0, 5);
  const maxEntityTotal = Math.max(
    ...entityTotals.map((total) => total.totalValue),
    1,
  );

  return (
    <section
      id={`channel-${channel.kind}`}
      aria-labelledby={`channel-${channel.kind}-heading`}
      className="flex min-w-0 scroll-mt-24 flex-col overflow-hidden rounded-lg border border-border/60 bg-card/80 shadow-amber-sm"
      data-testid={`channel-${channel.kind}`}
    >
      <div className="border-b border-border/60 p-5">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3
            id={`channel-${channel.kind}-heading`}
            className="text-lg font-semibold tracking-tight text-balance"
          >
            {channel.label}
          </h3>
          {channel.latestAsOf ? (
            <span className="font-mono text-xs tabular-nums text-muted-foreground">
              as at {channel.latestAsOf}
            </span>
          ) : null}
        </div>
        {channel.sources.length > 0 ? (
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {channel.sources
              .map((source) => `${source.displayName} — ${source.licence}`)
              .join(" · ")}
          </p>
        ) : null}
      </div>

      <div className="flex-1 space-y-4 p-5">
        <div className="grid gap-2 sm:grid-cols-3">
          <ChannelStat
            label={latest ? `FY ${latest.bucketLabel}` : "Latest"}
            value={
              latest && active
                ? formatMetricValue(latest.totalValue, active.unit)
                : "—"
            }
          />
          {latest && latest.entityCount === 0 ? (
            // Industry-level channels (e.g. ABS trade) carry no entity claims.
            <ChannelStat
              label="Records"
              value={String(latest.recordCount)}
              detail="industry-level"
            />
          ) : (
            <ChannelStat
              label="Entities"
              value={latest ? String(latest.entityCount) : "—"}
            />
          )}
          {noTax !== null ? (
            <ChannelStat
              label="No tax payable"
              value={String(noTax)}
              detail="latest FY, per ATO"
            />
          ) : (
            <ChannelStat
              label="All-time"
              value={
                active ? formatMetricValue(allTimeTotal, active.unit) : "—"
              }
            />
          )}
        </div>

        {series.length > 1 ? (
          <SegmentedToggle
            ariaLabel={`${channel.label} metric`}
            value={active?.metricKey ?? ""}
            onChange={setMetricKey}
            options={series.map((s) => ({
              value: s.metricKey,
              label: toggleLabelFor(s),
            }))}
          />
        ) : null}

        {chartData.length >= 2 && active ? (
          <figure className="min-w-0">
            <FyBucketBarChart
              data={chartData}
              format={formatForUnit(active.unit)}
              ariaLabel={`${active.metricLabel} by financial year for ${channel.label}`}
            />
            <figcaption className="sr-only">
              {active.metricLabel} totals by Australian financial year.
            </figcaption>
          </figure>
        ) : null}

        {entityTotals.length > 0 ? (
          <div>
            <h4 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
              Top entities
            </h4>
            <ul className="mt-2 space-y-1.5">
              {entityTotals.map((total) => (
                <li key={`${total.metricKey}:${total.stockCode}`}>
                  <Link
                    href={`/shorts/${total.stockCode}`}
                    prefetch={false}
                    className="group flex min-h-10 items-center gap-3 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/60"
                  >
                    <span className="w-12 shrink-0 font-mono text-xs font-semibold">
                      {total.stockCode}
                    </span>
                    <span className="relative h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                      <span
                        className="absolute inset-y-0 left-0 rounded-full bg-primary/80"
                        style={{
                          width: `${Math.max(
                            (total.totalValue / maxEntityTotal) * 100,
                            2,
                          )}%`,
                        }}
                      />
                    </span>
                    <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums">
                      {formatMetricValue(total.totalValue, total.unit)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="border-t border-border/60 bg-background/60 px-5 py-3">
        {channel.caveat ? (
          <p className="text-xs leading-5 text-muted-foreground text-pretty">
            {channel.caveat}
          </p>
        ) : null}
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs">
          {channel.sources[0] ? (
            <a
              href={channel.sources[0].sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex min-h-10 items-center gap-1 text-primary hover:underline"
            >
              {channel.sources[0].publisher}
              <ArrowUpRight className="h-3 w-3" aria-hidden="true" />
            </a>
          ) : (
            <span />
          )}
          <a
            href={`mailto:${REPORT_ERROR_EMAIL}?subject=${encodeURIComponent(
              `Data error report: ${channel.sources[0]?.sourceKey ?? channel.kind}`,
            )}`}
            className="inline-flex min-h-10 items-center gap-1 text-muted-foreground transition-colors hover:text-foreground"
          >
            <Flag className="h-3 w-3" aria-hidden="true" />
            Report an error
          </a>
        </div>
      </div>
    </section>
  );
}

function ChannelStat({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-background/70 p-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 break-words font-mono text-lg font-semibold tabular-nums">
        {value}
      </div>
      {detail ? (
        <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>
      ) : null}
    </div>
  );
}

function EvidenceExportButton({
  industryName,
  industrySlug,
  channels,
}: {
  industryName: string;
  industrySlug: string;
  channels: EvidenceChannel[];
}) {
  const { isPremium, isLoading } = useSubscription();

  if (!isPremium) {
    return (
      <Button asChild variant="outline" className="min-h-10">
        <Link
          href="/pricing"
          prefetch={false}
          data-testid="evidence-export-upgrade"
        >
          <Lock className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Export evidence summary
        </Link>
      </Button>
    );
  }

  const handleExport = () => {
    const rows = channels.flatMap((channel) =>
      channel.timeBuckets.map((bucket) => ({
        industry: industryName,
        channel: channel.label,
        source: bucket.sourceKey,
        metric: bucket.metricLabel,
        financial_year: bucket.bucketLabel,
        total_value: bucket.totalValue,
        unit: bucket.unit,
        records: bucket.recordCount,
        entities: bucket.entityCount,
      })),
    );
    downloadCSV(rows, `industry-intelligence-${industrySlug}.csv`);
  };

  return (
    <Button
      variant="outline"
      className="min-h-10"
      onClick={handleExport}
      disabled={isLoading}
      data-testid="evidence-export-button"
    >
      <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
      Export evidence summary
    </Button>
  );
}
