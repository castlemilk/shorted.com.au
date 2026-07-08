"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  AlertCircle,
  Files,
  Landmark,
  LogIn,
  Sparkles,
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

function SourceReadyCard({ module }: { module: SourceReadyModule }) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/70 p-4 shadow-amber-sm">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h3 className="font-semibold tracking-tight">{module.label}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {module.source.name}
          </p>
        </div>
        <Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">
          Source-ready
        </Badge>
      </div>
      <p className="text-sm text-muted-foreground text-pretty">
        Primary-source pipeline identified. Published values stay blank until
        imported, reconciled, and dated.
      </p>
      <div className="mt-4 border-t border-border/50 pt-3 text-xs text-muted-foreground">
        Cadence: {module.source.cadence}
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
      <div className="rounded-lg border border-border/60 bg-card/70 p-6 shadow-amber-sm md:p-8">
        <Badge
          variant="outline"
          className="mb-4 border-primary/25 bg-primary/10 text-primary"
        >
          Industry story
        </Badge>
        <h1 className="text-3xl font-bold tracking-tight">Industry Intelligence</h1>
        <p className="mt-3 max-w-2xl text-muted-foreground text-pretty">
          The next ASIC-backed industry sync will populate this page with live
          sector crowding, top stocks, and source-ready evidence modules.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
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
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-lg border border-border/60 bg-card/70 p-5 shadow-amber-sm md:p-8">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/50 to-transparent" />
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1.1fr)_minmax(320px,0.9fr)]">
          <div>
            <Badge
              variant="outline"
              className="mb-4 border-primary/25 bg-primary/10 text-primary"
            >
              Industry story
            </Badge>
            <h1 className="max-w-4xl text-4xl font-bold tracking-tight text-balance md:text-5xl">
              Industry Intelligence
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-muted-foreground text-pretty md:text-lg">
              Follow where short interest is crowding, then connect the sector
              view to top stocks, company pages, public-source evidence, and
              premium alerts.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <Button asChild className="min-h-10">
                <Link href="#industry-explorer">Explore industries</Link>
              </Button>
              <Button asChild variant="outline" className="min-h-10">
                <Link href="/alerts" prefetch={false}>
                  Create daily alert
                </Link>
              </Button>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <SignalTile
              label="Selected industry"
              value={selectedStory.industry.name}
              detail={`${selectedStory.industry.stockCount} stocks tracked`}
            />
            <SignalTile
              label="Average short"
              value={formatPercent(selectedStory.shortSignals.averageShortPercent)}
              detail="ASIC, daily T+4"
            />
            <SignalTile
              label="Highly shorted"
              value={String(selectedStory.shortSignals.highlyShortedCount)}
              detail="Above 10% short interest"
            />
            <SignalTile
              label="Rising"
              value={String(selectedStory.shortSignals.risingCount)}
              detail="Positive change in this panel"
            />
          </div>
        </div>
      </section>

      <section
        id="industry-explorer"
        className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)_minmax(360px,0.9fr)]"
      >
        <aside className="rounded-lg border border-border/60 bg-card/70 p-3 shadow-amber-sm lg:sticky lg:top-24 lg:self-start">
          <div className="px-2 pb-3">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              Industry selector
            </p>
          </div>
          <div className="space-y-1">
            {stories.map((story) => {
              const selected = story.industry.slug === selectedStory.industry.slug;

              return (
                <button
                  key={story.industry.slug}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setSelectedSlug(story.industry.slug)}
                  className={cn(
                    "flex min-h-11 w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                    selected
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                  )}
                >
                  <span className="truncate font-medium">{story.industry.name}</span>
                  <span className="font-mono text-xs tabular-nums">
                    {formatPercent(story.industry.avgShortPercent)}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <div className="space-y-6">
          <section className="rounded-lg border border-border/60 bg-card/70 p-5 shadow-amber-sm">
            <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
                  Crowding
                </p>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight text-balance">
                  {selectedStory.industry.name} short-interest signal
                </h2>
                <p className="mt-2 max-w-[64ch] text-sm text-muted-foreground text-pretty">
                  The live layer uses official ASIC short-position data. Other
                  public data layers stay labelled until the primary-source
                  imports are available.
                </p>
              </div>
              <Badge variant="outline" className="border-primary/25 bg-primary/10 text-primary">
                Primary-source import ready
              </Badge>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <MiniMetric
                label="Total short signal"
                value={formatPercent(selectedStory.industry.totalShortPercent)}
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
          </section>

          <section
            className="grid gap-3 md:grid-cols-2"
            aria-label="Source-ready public data modules"
          >
            {sourceModules.map((module) => (
              <SourceReadyCard key={module.label} module={module} />
            ))}
          </section>

          <section className="rounded-lg border border-primary/25 bg-primary/5 p-5 shadow-amber-sm">
            <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
              <div>
                <div className="mb-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary">
                  <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
                  Premium evidence pack
                </div>
                <h2 className="text-xl font-semibold tracking-tight text-balance">
                  Unlock deeper evidence for {selectedStory.industry.name}
                </h2>
                <p className="mt-2 max-w-[62ch] text-sm text-muted-foreground text-pretty">
                  Premium adds cited evidence tables, daily or weekly alerts,
                  change timelines, and exportable summaries. API Access stays
                  reserved for bulk feeds and automation.
                </p>
              </div>
              <div className="grid gap-2 sm:grid-cols-2 md:min-w-[300px]">
                <Button asChild className="min-h-10">
                  <Link href="/pricing" prefetch={false}>
                    <LogIn className="mr-2 h-4 w-4" aria-hidden="true" />
                    Unlock evidence pack
                  </Link>
                </Button>
                <Button asChild variant="outline" className="min-h-10">
                  <Link href={`/alerts?industry=${selectedStory.industry.slug}`} prefetch={false}>
                    <AlertCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                    Create daily alert
                  </Link>
                </Button>
                <Button asChild variant="outline" className="min-h-10">
                  <Link href="/pricing" prefetch={false}>
                    <Landmark className="mr-2 h-4 w-4" aria-hidden="true" />
                    Track this industry
                  </Link>
                </Button>
                <Button asChild variant="outline" className="min-h-10">
                  <Link href="/pricing" prefetch={false}>
                    <Files className="mr-2 h-4 w-4" aria-hidden="true" />
                    Export evidence summary
                  </Link>
                </Button>
              </div>
            </div>
          </section>
        </div>

        <IndustrySignalPanel
          story={selectedStory}
          className="lg:sticky lg:top-24 lg:self-start"
        />
      </section>

      <section className="rounded-lg border border-border/60 bg-card/70 p-5 shadow-amber-sm">
        <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
              <Files className="h-3.5 w-3.5" aria-hidden="true" />
              Source posture
            </div>
            <h2 className="text-xl font-semibold tracking-tight">
              Neutral, cited, and dated by design
            </h2>
            <p className="mt-2 max-w-[78ch] text-sm text-muted-foreground text-pretty">
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

function SignalTile({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-lg border border-border/60 bg-background/70 p-4">
      <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
      <div className="mt-2 truncate font-mono text-2xl font-semibold tabular-nums">
        {value}
      </div>
      <div className="mt-1 text-xs text-muted-foreground">{detail}</div>
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
