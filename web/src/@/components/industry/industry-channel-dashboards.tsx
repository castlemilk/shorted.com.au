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
    channel.timeBuckets.filter((b) => b.metricKey === metricKey).at(-1);
  const income = latestFor("total_income");
  const payable = latestFor("tax_payable");
  if (!income) return null;
  const payableEntities =
    payable && payable.bucketLabel === income.bucketLabel
      ? payable.entityCount
      : 0;
  return Math.max(income.entityCount - payableEntities, 0);
}

/**
 * Full-width dossier view for one evidence channel: attribution header, FY
 * chart with metric toggle, figures column, top entities, standing caveat.
 * Flat by design — hairlines separate regions, nothing nests inside a card.
 */
export function ChannelDetail({ channel }: { channel: EvidenceChannel }) {
  const series = useMemo(() => metricSeriesForChannel(channel), [channel]);
  const [metricKey, setMetricKey] = useState(series[0]?.metricKey ?? "");
  const active =
    series.find((s) => s.metricKey === metricKey) ?? series[0] ?? null;
  const noTax = noTaxPayableCount(channel);

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
    .slice(0, 8);
  const maxEntityTotal = Math.max(
    ...entityTotals.map((total) => total.totalValue),
    1,
  );

  return (
    <section
      aria-labelledby={`channel-${channel.kind}-heading`}
      data-testid={`channel-${channel.kind}`}
      className="min-w-0"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 border-b border-border/60 pb-4">
        <div className="min-w-0">
          <h2
            id={`channel-${channel.kind}-heading`}
            className="text-xl font-semibold tracking-tight text-balance"
          >
            {channel.label}
          </h2>
          {channel.sources.length > 0 ? (
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {channel.sources
                .map((source) => `${source.displayName} — ${source.licence}`)
                .join(" · ")}
            </p>
          ) : null}
        </div>
        {channel.latestAsOf ? (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            as at {channel.latestAsOf}
          </span>
        ) : null}
      </header>

      <div className="grid min-w-0 gap-x-10 gap-y-6 pt-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="min-w-0 space-y-4">
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
              <figcaption className="mt-1 text-xs text-muted-foreground">
                {active.metricLabel} by Australian financial year
                {chartData.length === 16 ? " (most recent 16 years)" : ""}.
              </figcaption>
            </figure>
          ) : null}

          {entityTotals.length > 0 ? (
            <div className="pt-2">
              <h3 className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Top entities
              </h3>
              <ul className="mt-2">
                {entityTotals.map((total) => (
                  <li
                    key={`${total.metricKey}:${total.stockCode}`}
                    className="border-b border-border/40 last:border-b-0"
                  >
                    <Link
                      href={`/shorts/${total.stockCode}`}
                      prefetch={false}
                      className="group flex min-h-10 items-center gap-4 py-1 transition-colors hover:bg-muted/50"
                    >
                      <span className="w-12 shrink-0 font-mono text-xs font-semibold group-hover:text-primary">
                        {total.stockCode}
                      </span>
                      <span className="hidden min-w-0 flex-1 truncate text-xs text-muted-foreground sm:block">
                        {total.entityLabel}
                      </span>
                      <span className="relative h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted sm:w-36">
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

        <aside className="min-w-0 lg:border-l lg:border-border/60 lg:pl-8">
          <dl className="grid grid-cols-2 gap-x-6 gap-y-5 lg:grid-cols-1">
            <ChannelFigure
              label={latest ? `FY ${latest.bucketLabel}` : "Latest"}
              value={
                latest && active
                  ? formatMetricValue(latest.totalValue, active.unit)
                  : "—"
              }
            />
            {latest && latest.entityCount === 0 ? (
              <ChannelFigure
                label="Records"
                value={String(latest.recordCount)}
                detail="industry-level"
              />
            ) : (
              <ChannelFigure
                label="Entities"
                value={latest ? String(latest.entityCount) : "—"}
              />
            )}
            {noTax !== null ? (
              <ChannelFigure
                label="No tax payable"
                value={String(noTax)}
                detail="latest FY, per ATO"
              />
            ) : (
              <ChannelFigure
                label="All-time"
                value={
                  active ? formatMetricValue(allTimeTotal, active.unit) : "—"
                }
              />
            )}
          </dl>
        </aside>
      </div>

      <footer className="mt-6 border-t border-border/60 pt-3">
        {channel.caveat ? (
          <p className="max-w-3xl text-xs leading-5 text-muted-foreground text-pretty">
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
      </footer>
    </section>
  );
}

function ChannelFigure({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 break-words font-mono text-2xl font-semibold tabular-nums">
        {value}
      </dd>
      {detail ? (
        <dd className="mt-0.5 text-[11px] text-muted-foreground">{detail}</dd>
      ) : null}
    </div>
  );
}

export function EvidenceExportButton({
  industryName,
  industrySlug,
  channels,
}: {
  industryName: string;
  industrySlug: string;
  channels: EvidenceChannel[];
}) {
  const { isPremium, isLoading } = useSubscription();

  if (channels.length === 0) return null;

  if (!isPremium) {
    return (
      <Button asChild variant="outline" className="min-h-10">
        <Link
          href="/pricing"
          prefetch={false}
          data-testid="evidence-export-upgrade"
        >
          <Lock className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
          Export evidence
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
      Export evidence
    </Button>
  );
}
