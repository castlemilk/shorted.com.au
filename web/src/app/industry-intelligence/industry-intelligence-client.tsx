"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  ArrowUpRight,
  Files,
  Landmark,
  LogIn,
  Sparkles,
  TrendingDown,
} from "lucide-react";

import { IndustrySignalPanel } from "~/@/components/industry/industry-signal-panel";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { cn } from "~/@/lib/utils";
import type {
  IndustryIntelligenceStory,
  SourceReadyModule,
} from "~/@/lib/industry-intelligence";

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

const narrativeSteps = [
  {
    label: "Crowding",
    detail: "Live ASIC short-interest layer",
    status: "Live",
  },
  {
    label: "Top Stocks",
    detail: "Sector leaders linked to company pages",
    status: "Live",
  },
  {
    label: "Exposure",
    detail: "Trade and industry dependency inputs",
    status: "Source-ready",
  },
  {
    label: "Public Money",
    detail: "Grants and tender evidence pipeline",
    status: "Source-ready",
  },
  {
    label: "Policy Footprint",
    detail: "Register and disclosure evidence pipeline",
    status: "Source-ready",
  },
  {
    label: "Alerts",
    detail: "Premium daily and weekly monitoring",
    status: "Premium",
  },
];

function SourceReadyCard({ module }: { module: SourceReadyModule }) {
  return (
    <div className="group rounded-lg border border-border/60 bg-card/80 p-4 shadow-amber-sm transition-colors hover:border-primary/30">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold tracking-tight">{module.label}</h3>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            {module.source.name}
          </p>
        </div>
        <Badge
          variant="outline"
          className="border-primary/25 bg-primary/10 text-primary"
        >
          Source-ready
        </Badge>
      </div>
      <p className="text-sm leading-6 text-muted-foreground text-pretty">
        Primary-source pipeline identified. Published values stay blank until
        imported, reconciled, reviewed, and dated.
      </p>
      <div className="mt-4 flex items-center justify-between border-t border-border/50 pt-3 text-xs text-muted-foreground">
        <span>Cadence</span>
        <span className="font-medium text-foreground">
          {module.source.cadence}
        </span>
      </div>
    </div>
  );
}

export function IndustryIntelligenceClient({
  stories,
  initialSlug,
}: {
  stories: IndustryIntelligenceStory[];
  initialSlug?: string;
}) {
  const initialStory = useMemo(
    () =>
      stories.find((story) => story.industry.slug === initialSlug) ??
      stories[0] ??
      null,
    [initialSlug, stories],
  );
  const [selectedSlug, setSelectedSlug] = useState(initialStory?.industry.slug);
  const selectedStory = useMemo(
    () =>
      stories.find((story) => story.industry.slug === selectedSlug) ??
      initialStory,
    [initialStory, selectedSlug, stories],
  );

  if (!selectedStory) {
    return (
      <div className="overflow-hidden rounded-lg border border-border/60 bg-card/80 shadow-amber-sm">
        <div className="border-b border-border/60 bg-primary/5 px-6 py-5">
          <Badge
            variant="outline"
            className="mb-4 border-primary/25 bg-primary/10 text-primary"
          >
            Industry story
          </Badge>
          <h1 className="text-3xl font-bold tracking-tight">
            Industry Intelligence
          </h1>
          <p className="mt-3 max-w-2xl text-muted-foreground text-pretty">
            The next ASIC-backed industry sync will populate this page with live
            sector crowding, top stocks, and source-ready evidence modules.
          </p>
        </div>
        <div className="flex flex-col gap-3 p-6 sm:flex-row">
          <Button asChild className="min-h-10">
            <Link href="/top" prefetch={false}>
              View top shorts
            </Link>
          </Button>
          <Button asChild variant="outline" className="min-h-10">
            <Link href="/industry" prefetch={false}>
              Browse industries
            </Link>
          </Button>
          <Button asChild variant="outline" className="min-h-10">
            <Link href="/stocks" prefetch={false}>
              Find a stock
            </Link>
          </Button>
        </div>
      </div>
    );
  }

  const sourceModules = [
    selectedStory.tradeExposure,
    selectedStory.publicMoney,
    selectedStory.taxEnvironment,
    selectedStory.policyFootprint,
  ];

  return (
    <div className="space-y-8" data-testid="industry-intelligence-story">
      <section className="relative isolate overflow-hidden rounded-lg border border-border/60 bg-card/80 shadow-amber-sm">
        <div className="absolute inset-x-0 top-0 h-1 bg-primary" />
        <div className="grid min-h-[430px] gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(390px,0.72fr)]">
          <div className="flex flex-col justify-between p-6 md:p-8">
            <div>
              <div className="mb-5 flex flex-wrap items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-primary/25 bg-primary/10 text-primary"
                >
                  Industry story
                </Badge>
                <Badge
                  variant="outline"
                  className="border-border/60 bg-background/70"
                >
                  ASIC daily T+4
                </Badge>
                <Badge
                  variant="outline"
                  className="border-border/60 bg-background/70"
                >
                  Evidence packs planned
                </Badge>
              </div>
              <h1 className="max-w-4xl text-4xl font-bold tracking-tight text-balance md:text-6xl">
                Industry Intelligence
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground text-pretty md:text-lg">
                A sector story built from live short-interest crowding, top
                stocks, source-ready public data channels, and premium alert
                workflows.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <Button asChild className="min-h-11 px-5">
                  <Link href="#industry-explorer">Explore industries</Link>
                </Button>
                <Button asChild variant="outline" className="min-h-11 px-5">
                  <Link
                    href={`/alerts?industry=${selectedStory.industry.slug}`}
                    prefetch={false}
                  >
                    Create daily alert
                  </Link>
                </Button>
              </div>
            </div>

            <div className="mt-8 grid gap-3 sm:grid-cols-3">
              <HeroProofPoint
                icon={<TrendingDown className="h-4 w-4" aria-hidden="true" />}
                label="Live now"
                value="ASIC short interest"
              />
              <HeroProofPoint
                icon={<Files className="h-4 w-4" aria-hidden="true" />}
                label="Next layer"
                value="Public-source evidence"
              />
              <HeroProofPoint
                icon={<AlertCircle className="h-4 w-4" aria-hidden="true" />}
                label="Conversion path"
                value="Premium alerts"
              />
            </div>
          </div>

          <HeroSignalBoard story={selectedStory} />
        </div>
      </section>

      <section
        id="industry-explorer"
        className="grid gap-6 lg:grid-cols-[230px_minmax(0,1fr)_minmax(360px,0.78fr)]"
      >
        <NarrativeRail />

        <div className="space-y-6">
          <IndustrySelector
            stories={stories}
            selectedSlug={selectedStory.industry.slug}
            onSelect={setSelectedSlug}
          />

          <section className="overflow-hidden rounded-lg border border-border/60 bg-card/80 shadow-amber-sm">
            <div className="border-b border-border/60 p-5">
              <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
                    Crowding
                  </p>
                  <h2 className="mt-2 text-2xl font-semibold tracking-tight text-balance">
                    {selectedStory.industry.name} short-interest signal
                  </h2>
                  <p className="mt-2 max-w-[64ch] text-sm leading-6 text-muted-foreground text-pretty">
                    The live layer uses official ASIC short-position data. Other
                    public data layers stay labelled until primary-source
                    imports are available.
                  </p>
                </div>
                <Badge
                  variant="outline"
                  className="border-primary/25 bg-primary/10 text-primary"
                >
                  Primary-source live
                </Badge>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                <MiniMetric
                  label="Average short"
                  value={formatPercent(
                    selectedStory.shortSignals.averageShortPercent,
                  )}
                />
                <MiniMetric
                  label="Stocks tracked"
                  value={String(selectedStory.industry.stockCount)}
                />
                <MiniMetric
                  label="Top ticker"
                  value={selectedStory.topShortedStocks[0]?.code ?? "N/A"}
                />
              </div>
            </div>

            <CrowdingChart story={selectedStory} />
          </section>

          <section
            id="source-ready-modules"
            className="grid gap-3 md:grid-cols-2"
            aria-label="Source-ready public data modules"
          >
            {sourceModules.map((module) => (
              <SourceReadyCard key={module.label} module={module} />
            ))}
          </section>

          <EvidencePackPanel story={selectedStory} />
        </div>

        <IndustrySignalPanel
          story={selectedStory}
          className="lg:sticky lg:top-24 lg:self-start"
        />
      </section>

      <section className="rounded-lg border border-border/60 bg-card/80 p-5 shadow-amber-sm">
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              <Files className="h-3.5 w-3.5" aria-hidden="true" />
              Source posture
            </div>
            <h2 className="text-xl font-semibold tracking-tight">
              Neutral, cited, and dated by design
            </h2>
            <p className="mt-2 max-w-[78ch] text-sm leading-6 text-muted-foreground text-pretty">
              Industry Intelligence juxtaposes primary-source facts. It does not
              infer intent, causation, or undisclosed relationships from public
              records.
            </p>
          </div>
          <Button asChild variant="outline" className="min-h-10">
            <Link href="/methodology" prefetch={false}>
              Read methodology
            </Link>
          </Button>
        </div>
      </section>
    </div>
  );
}

function HeroSignalBoard({ story }: { story: IndustryIntelligenceStory }) {
  const topStocks = story.topShortedStocks.slice(0, 4);

  return (
    <div className="border-t border-border/60 bg-zinc-950 p-5 text-zinc-100 lg:border-l lg:border-t-0 md:p-6">
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber-300">
              Live industry board
            </p>
            <h2 className="mt-2 max-w-[13ch] text-2xl font-semibold tracking-tight text-white">
              {story.industry.name}
            </h2>
          </div>
          <div className="rounded-md border border-amber-300/25 bg-amber-300/10 px-3 py-2 text-right">
            <div className="text-[11px] uppercase tracking-[0.14em] text-amber-200">
              Avg short
            </div>
            <div className="font-mono text-xl font-semibold tabular-nums text-amber-100">
              {formatPercent(story.shortSignals.averageShortPercent)}
            </div>
          </div>
        </div>

        <div className="mt-6 grid gap-3 sm:grid-cols-3 lg:grid-cols-1 xl:grid-cols-3">
          <DarkMetric
            label="Tracked"
            value={String(story.industry.stockCount)}
            detail="ASX stocks"
          />
          <DarkMetric
            label="Highly shorted"
            value={String(story.shortSignals.highlyShortedCount)}
            detail="Above 10%"
          />
          <DarkMetric
            label="Rising"
            value={String(story.shortSignals.risingCount)}
            detail="Panel change"
          />
        </div>

        <div className="mt-6 overflow-hidden rounded-md border border-zinc-800">
          {topStocks.map((stock) => (
            <Link
              key={stock.code}
              href={stock.href}
              prefetch={false}
              className="grid grid-cols-[42px_minmax(0,1fr)_72px] items-center gap-3 border-b border-zinc-800 px-3 py-3 text-sm last:border-b-0 hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/50"
            >
              <span className="font-mono text-xs text-zinc-500">
                #{stock.rank}
              </span>
              <span className="min-w-0">
                <span className="block font-semibold text-white">
                  {stock.code}
                </span>
                <span className="block truncate text-xs text-zinc-400">
                  {stock.name}
                </span>
              </span>
              <span className="text-right font-mono font-semibold tabular-nums text-amber-100">
                {formatPercent(stock.shortPercent)}
              </span>
            </Link>
          ))}
        </div>

        <div className="mt-auto pt-6 text-xs leading-5 text-zinc-400">
          Source: ASIC short position reports. Other public-data channels remain
          source-ready until imported.
        </div>
      </div>
    </div>
  );
}

function NarrativeRail() {
  return (
    <aside className="rounded-lg border border-border/60 bg-card/80 p-3 shadow-amber-sm lg:sticky lg:top-24 lg:self-start">
      <div className="px-2 pb-3">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Narrative rail
        </p>
      </div>
      <ol className="space-y-1">
        {narrativeSteps.map((step, index) => (
          <li key={step.label}>
            <a
              href={index < 2 ? "#industry-explorer" : "#source-ready-modules"}
              className="group grid grid-cols-[24px_minmax(0,1fr)] gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <span
                className={cn(
                  "mt-0.5 flex h-5 w-5 items-center justify-center rounded-full border font-mono text-[10px]",
                  index < 2
                    ? "border-primary/30 bg-primary/10 text-primary"
                    : "border-border/70 text-muted-foreground",
                )}
              >
                {index + 1}
              </span>
              <span className="min-w-0">
                <span className="flex items-center justify-between gap-2">
                  <span className="font-medium text-foreground">
                    {step.label}
                  </span>
                  <span
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-[0.12em]",
                      step.status === "Live"
                        ? "border-primary/25 bg-primary/10 text-primary"
                        : "border-border/60 text-muted-foreground",
                    )}
                  >
                    {step.status}
                  </span>
                </span>
                <span className="mt-1 block text-xs leading-4 text-muted-foreground">
                  {step.detail}
                </span>
              </span>
            </a>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function IndustrySelector({
  stories,
  selectedSlug,
  onSelect,
}: {
  stories: IndustryIntelligenceStory[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
}) {
  return (
    <section className="rounded-lg border border-border/60 bg-card/80 p-4 shadow-amber-sm">
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
            Main explorer
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            Select an industry
          </h2>
        </div>
        <Button
          asChild
          variant="ghost"
          size="sm"
          className="justify-start sm:justify-center"
        >
          <Link href="/industry" prefetch={false}>
            Open full industry index
            <ArrowUpRight className="ml-2 h-3.5 w-3.5" aria-hidden="true" />
          </Link>
        </Button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {stories.map((story) => {
          const selected = story.industry.slug === selectedSlug;

          return (
            <button
              key={story.industry.slug}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(story.industry.slug)}
              className={cn(
                "min-h-[76px] rounded-md border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                selected
                  ? "border-primary/40 bg-primary/10"
                  : "border-border/60 bg-background/60 hover:border-primary/25 hover:bg-muted/60",
              )}
            >
              <span className="block truncate font-medium">
                {story.industry.name}
              </span>
              <span className="mt-3 flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{story.industry.stockCount} stocks</span>
                <span className="font-mono tabular-nums">
                  {formatPercent(story.industry.avgShortPercent)}
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function CrowdingChart({ story }: { story: IndustryIntelligenceStory }) {
  const stocks = story.topShortedStocks.slice(0, 6);
  const maxShort = Math.max(...stocks.map((stock) => stock.shortPercent), 1);

  return (
    <div className="p-5" data-testid="industry-crowding-chart">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
          <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />
          Short crowding chart
        </div>
        <span className="text-xs text-muted-foreground">
          {story.shortSignals.source.name}, {story.shortSignals.source.cadence}
        </span>
      </div>
      <div className="space-y-3">
        {stocks.length > 0 ? (
          stocks.map((stock) => (
            <Link
              key={stock.code}
              href={stock.href}
              prefetch={false}
              className="grid grid-cols-[56px_minmax(0,1fr)_70px] items-center gap-3 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              <span className="font-mono text-sm font-semibold text-foreground">
                {stock.code}
              </span>
              <span
                className="h-3 overflow-hidden rounded-full bg-muted"
                aria-hidden="true"
              >
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{
                    width: `${Math.max(8, (stock.shortPercent / maxShort) * 100)}%`,
                  }}
                />
              </span>
              <span className="text-right font-mono text-sm font-semibold tabular-nums">
                {formatPercent(stock.shortPercent)}
              </span>
            </Link>
          ))
        ) : (
          <p className="rounded-md border border-border/60 bg-background/60 p-4 text-sm text-muted-foreground">
            No ranked stocks are available for this industry yet.
          </p>
        )}
      </div>
    </div>
  );
}

function EvidencePackPanel({ story }: { story: IndustryIntelligenceStory }) {
  return (
    <section className="rounded-lg border border-primary/25 bg-primary/5 p-5 shadow-amber-sm">
      <div className="grid gap-5 2xl:grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)] 2xl:items-start">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Premium evidence pack
          </div>
          <h2 className="text-xl font-semibold tracking-tight text-balance">
            Unlock deeper evidence for {story.industry.name}
          </h2>
          <p className="mt-2 max-w-[62ch] text-sm leading-6 text-muted-foreground text-pretty">
            Premium adds cited evidence tables, daily or weekly alerts, change
            timelines, and exportable summaries. API Access stays reserved for
            bulk feeds and automation.
          </p>
          <div className="mt-4 grid gap-2 md:grid-cols-3 lg:grid-cols-1 2xl:grid-cols-3">
            <EntitlementPill label="Free" value="Live crowding" />
            <EntitlementPill label="Premium" value="Alerts and packs" />
            <EntitlementPill label="API Access" value="Bulk feeds" />
          </div>
        </div>
        <div className="grid gap-2 sm:grid-cols-2 2xl:grid-cols-1">
          <Button asChild className="min-h-10 justify-start">
            <Link href="/pricing" prefetch={false}>
              <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
              Unlock evidence pack
            </Link>
          </Button>
          <Button asChild variant="outline" className="min-h-10 justify-start">
            <Link
              href={`/alerts?industry=${story.industry.slug}`}
              prefetch={false}
            >
              <AlertCircle className="mr-2 h-4 w-4" aria-hidden="true" />
              Create daily alert
            </Link>
          </Button>
          <Button asChild variant="outline" className="min-h-10 justify-start">
            <Link href="/pricing" prefetch={false}>
              <Landmark className="mr-2 h-4 w-4" aria-hidden="true" />
              Track this industry
            </Link>
          </Button>
          <Button asChild variant="outline" className="min-h-10 justify-start">
            <Link href="/pricing" prefetch={false}>
              <Files className="mr-2 h-4 w-4" aria-hidden="true" />
              Export evidence summary
            </Link>
          </Button>
        </div>
      </div>
    </section>
  );
}

function HeroProofPoint({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-md border border-border/60 bg-background/70 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-[0.14em] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-semibold text-foreground">{value}</div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border/60 bg-background/70 p-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 font-mono text-xl font-semibold tabular-nums">
        {value}
      </div>
    </div>
  );
}

function DarkMetric({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-md border border-zinc-800 bg-white/[0.03] p-3">
      <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
        {label}
      </div>
      <div className="mt-2 font-mono text-xl font-semibold tabular-nums text-white">
        {value}
      </div>
      <div className="mt-1 text-xs text-zinc-500">{detail}</div>
    </div>
  );
}

function EntitlementPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-primary/20 bg-background/60 px-3 py-2">
      <div className="text-[11px] uppercase tracking-[0.14em] text-primary">
        {label}
      </div>
      <div className="mt-1 text-xs font-medium text-foreground">{value}</div>
    </div>
  );
}
