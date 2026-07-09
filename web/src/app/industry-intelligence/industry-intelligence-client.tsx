"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import Image from "next/image";
import {
  AlertCircle,
  ArrowUpRight,
  TrendingDown,
} from "lucide-react";

import { IndustrySignalPanel } from "~/@/components/industry/industry-signal-panel";
import {
  IndustryChannelDashboards,
  IndustryCrowdingChart,
} from "~/@/components/industry/industry-charts";
import { IndustryMethodology } from "~/@/components/industry/industry-methodology";
import {
  IndustryNarrativeRail,
  type NarrativeRailItem,
} from "~/@/components/industry/industry-narrative-rail";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { getSectorImageAlt, getSectorImagePath } from "~/@/lib/sector-images";
import { cn } from "~/@/lib/utils";
import type { IndustryIntelligenceStory } from "~/@/lib/industry-intelligence";

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
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
  const leadStock = selectedStory?.topShortedStocks[0] ?? null;
  const asAt = selectedStory?.shortSignals.source.asAt ?? "";
  const railItems = useMemo<NarrativeRailItem[]>(() => {
    if (!selectedStory) return [];
    const items: NarrativeRailItem[] = [
      { id: "industry-explorer", label: "Overview" },
    ];
    if (selectedStory.crowding) {
      items.push({ id: "crowding", label: "Crowding" });
    }
    items.push({ id: "top-shorts", label: "Top shorted" });
    for (const channel of selectedStory.channels) {
      items.push({ id: `channel-${channel.kind}`, label: channel.label });
    }
    items.push({ id: "alerts", label: "Alerts" });
    items.push({ id: "methodology", label: "Sources" });
    return items;
  }, [selectedStory]);

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
            Industry data is syncing. You can still browse top shorts,
            industries, and stock search while this view refreshes.
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

  return (
    <div className="space-y-8" data-testid="industry-intelligence-story">
      <section className="relative isolate overflow-hidden rounded-lg border border-border/60 bg-card/80 shadow-amber-sm">
        <div className="absolute inset-x-0 top-0 h-1 bg-primary" />
        <div className="grid min-h-[430px] min-w-0 gap-0 lg:grid-cols-[minmax(0,1fr)_minmax(390px,0.72fr)]">
          <div className="min-w-0 flex flex-col justify-between p-6 md:p-8">
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
              </div>
              <h1 className="max-w-4xl break-words text-3xl font-bold leading-tight tracking-tight text-balance sm:text-4xl md:text-6xl">
                Industry Intelligence
              </h1>
              <p className="mt-5 max-w-2xl text-base leading-7 text-muted-foreground text-pretty md:text-lg">
                Compare industry short-interest, ranked companies, and alert
                entry points from one clean sector view.
              </p>
              <div className="mt-7 flex flex-col gap-3 sm:flex-row">
                <Button asChild className="min-h-11 w-full px-5 sm:w-auto">
                  <Link href="#industry-explorer">Explore industries</Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="min-h-11 w-full px-5 sm:w-auto"
                >
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
                label="Average short"
                value={formatPercent(
                  selectedStory.shortSignals.averageShortPercent,
                )}
              />
              <HeroProofPoint
                icon={<ArrowUpRight className="h-4 w-4" aria-hidden="true" />}
                label="Tracked stocks"
                value={String(selectedStory.industry.stockCount)}
              />
              <HeroProofPoint
                icon={<AlertCircle className="h-4 w-4" aria-hidden="true" />}
                label="Lead short"
                value={
                  leadStock
                    ? `${leadStock.code} ${formatPercent(leadStock.shortPercent)}`
                    : "N/A"
                }
              />
            </div>
          </div>

          <HeroSignalBoard story={selectedStory} />
        </div>
      </section>

      <div className="grid min-w-0 gap-6 xl:grid-cols-[190px_minmax(0,1fr)]">
        <div className="min-w-0 xl:sticky xl:top-20 xl:self-start">
          <IndustryNarrativeRail items={railItems} />
        </div>

        <div className="min-w-0 space-y-8">
          <section id="industry-explorer" className="scroll-mt-24 space-y-5">
            <IndustrySelector
              stories={stories}
              selectedSlug={selectedStory.industry.slug}
              onSelect={setSelectedSlug}
            />

            {selectedStory.crowding ? (
              <CrowdingCard story={selectedStory} />
            ) : null}

            <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(340px,0.38fr)]">
              <IndustrySignalPanel
                story={selectedStory}
                stockLimit={10}
                id="top-shorts"
                className="min-w-0"
              />

              <AlertsPanel story={selectedStory} />
            </div>
          </section>

          <IndustryChannelDashboards
            industryName={selectedStory.industry.name}
            industrySlug={selectedStory.industry.slug}
            channels={selectedStory.channels}
          />

          <IndustryMethodology channels={selectedStory.channels} asAt={asAt} />
        </div>
      </div>
    </div>
  );
}

function CrowdingCard({ story }: { story: IndustryIntelligenceStory }) {
  if (!story.crowding) return null;
  const points = story.crowding.points;
  const latest = points[points.length - 1]!;

  return (
    <section
      id="crowding"
      aria-labelledby="crowding-heading"
      className="min-w-0 scroll-mt-24 overflow-hidden rounded-lg border border-border/60 bg-card/80 shadow-amber-sm"
      data-testid="industry-crowding-card"
    >
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/60 p-5">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
            Crowding
          </p>
          <h2
            id="crowding-heading"
            className="mt-1 text-xl font-semibold tracking-tight text-balance"
          >
            {story.industry.name} short-interest crowding
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted-foreground text-pretty">
            Weekly constituent average with the p10–p90 dispersion band.
          </p>
        </div>
        <div className="rounded-md border border-border/60 bg-background/70 px-3 py-2 text-right">
          <div className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
            Latest week
          </div>
          <div className="font-mono text-lg font-semibold tabular-nums">
            {formatPercent(latest.avg)}
          </div>
        </div>
      </div>
      <div className="p-4" style={{ minHeight: 268 }}>
        <IndustryCrowdingChart
          points={points}
          industryName={story.industry.name}
        />
      </div>
      <div className="border-t border-border/60 bg-background/60 px-5 py-3 text-xs leading-5 text-muted-foreground">
        Source: ASIC short position reports (daily, T+4). Weeks with fewer than
        three reporting constituents are omitted.
      </div>
    </section>
  );
}

function HeroSignalBoard({ story }: { story: IndustryIntelligenceStory }) {
  const leader = story.topShortedStocks[0];

  return (
    <div className="min-w-0 border-t border-border/60 bg-zinc-950 p-5 text-zinc-100 lg:border-l lg:border-t-0 md:p-6">
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-amber-300/20 bg-amber-300/10 p-1.5">
              <Image
                src={getSectorImagePath(story.industry.name)}
                alt={getSectorImageAlt(story.industry.name)}
                width={46}
                height={46}
                className="h-full w-full object-contain"
              />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-amber-300">
                Industry board
              </p>
              <h2 className="mt-2 max-w-[13ch] text-2xl font-semibold tracking-tight text-white">
                {story.industry.name}
              </h2>
            </div>
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

        <div className="mt-6 rounded-md border border-zinc-800 bg-white/[0.03] p-4">
          <div className="text-[11px] uppercase tracking-[0.14em] text-zinc-500">
            Current focus
          </div>
          <div className="mt-2 text-sm leading-6 text-zinc-300 text-pretty">
            Sector-level movement for the selected industry, with lead stock
            context from the current ASIC short-position set.
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
            <DarkMetric
              label="Lead ticker"
              value={leader?.code ?? "N/A"}
              detail={leader?.name ?? "No ranked stock"}
            />
            <DarkMetric
              label="Lead short"
              value={leader ? formatPercent(leader.shortPercent) : "N/A"}
              detail="Highest ranked"
            />
          </div>
        </div>

        <div className="mt-auto pt-6 text-xs leading-5 text-zinc-400">
          Source: ASIC short position reports. Updated with the T+4 reporting
          delay.
        </div>
      </div>
    </div>
  );
}

function IndustrySelector({
  stories,
  selectedSlug,
  onSelect,
  className,
}: {
  stories: IndustryIntelligenceStory[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "min-w-0 rounded-lg border border-border/60 bg-card/80 p-4 shadow-amber-sm",
        className,
      )}
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
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
          className="h-auto min-h-10 justify-start whitespace-normal text-left sm:justify-center"
        >
          <Link href="/industry" prefetch={false}>
            <span>Open full industry index</span>
            <ArrowUpRight
              className="ml-2 h-3.5 w-3.5 shrink-0"
              aria-hidden="true"
            />
          </Link>
        </Button>
      </div>
      <div className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {stories.map((story) => {
          const selected = story.industry.slug === selectedSlug;

          return (
            <button
              key={story.industry.slug}
              type="button"
              aria-pressed={selected}
              onClick={() => onSelect(story.industry.slug)}
              className={cn(
                "min-h-[96px] w-full overflow-hidden rounded-md border px-3 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                selected
                  ? "border-primary/40 bg-primary/10"
                  : "border-border/60 bg-background/60 hover:border-primary/25 hover:bg-muted/60",
              )}
            >
              <span className="flex min-w-0 items-start gap-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-border/60 bg-card p-1">
                  <Image
                    src={getSectorImagePath(story.industry.name)}
                    alt={getSectorImageAlt(story.industry.name)}
                    width={32}
                    height={32}
                    className="h-full w-full object-contain"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-2 break-words font-medium leading-5">
                    {story.industry.name}
                  </span>
                  <span className="mt-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    <span>{story.industry.stockCount} stocks</span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {formatPercent(story.industry.avgShortPercent)}
                    </span>
                  </span>
                </span>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function AlertsPanel({
  story,
  className,
}: {
  story: IndustryIntelligenceStory;
  className?: string;
}) {
  return (
    <section
      id="alerts"
      className={cn(
        "min-w-0 overflow-hidden rounded-lg border border-primary/25 bg-primary/5 shadow-amber-sm",
        className,
      )}
    >
      <div className="grid gap-0">
        <div className="p-5">
          <div className="mb-2 inline-flex items-center gap-2 text-xs font-medium uppercase tracking-[0.16em] text-primary">
            <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
            Alerts
          </div>
          <h2 className="text-2xl font-semibold tracking-tight text-balance">
            Track {story.industry.name} changes
          </h2>
          <p className="mt-2 max-w-[44ch] text-sm leading-6 text-muted-foreground text-pretty">
            Create an industry monitor and return to the alerts workspace when
            short interest moves across the sector.
          </p>

          <div className="mt-5 grid gap-2 sm:grid-cols-3 xl:grid-cols-1">
            <MiniMetric
              label="Cadence"
              value={story.alerts.cadences.join(" / ")}
            />
            <MiniMetric
              label="Tracked"
              value={String(story.industry.stockCount)}
            />
            <MiniMetric
              label="Lead ticker"
              value={story.topShortedStocks[0]?.code ?? "N/A"}
            />
          </div>
        </div>

        <div className="border-t border-primary/20 bg-background/75 p-5">
          <div className="grid gap-2">
            <Button asChild className="min-h-10 justify-start">
              <Link
                href={`/alerts?industry=${story.industry.slug}`}
                prefetch={false}
              >
                <AlertCircle className="mr-2 h-4 w-4" aria-hidden="true" />
                Create daily alert
              </Link>
            </Button>
            <Button
              asChild
              variant="outline"
              className="min-h-10 justify-start"
            >
              <Link href={`/industry/${story.industry.slug}`} prefetch={false}>
                Review industry
                <ArrowUpRight className="ml-2 h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </Button>
          </div>
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
    <div className="min-w-0 rounded-md border border-border/60 bg-background/70 p-3">
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
      <div className="mt-2 break-words font-mono text-lg font-semibold tabular-nums sm:text-xl">
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
