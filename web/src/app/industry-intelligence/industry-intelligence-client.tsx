"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import Link from "next/link";
import Image from "next/image";
import { AlertCircle, ArrowUpRight } from "lucide-react";

import { IndustrySignalPanel } from "~/@/components/industry/industry-signal-panel";
import {
  ChannelDetail,
  EvidenceExportButton,
  IndustryCrowdingChart,
} from "~/@/components/industry/industry-charts";
import { IndustryMethodology } from "~/@/components/industry/industry-methodology";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "~/@/components/ui/tabs";
import { IntelLockCard } from "~/@/components/ui/intel-lock";
import { SegmentedToggle } from "~/@/components/features/housing/charts/chart-ui";
import { getSectorImageAlt, getSectorImagePath } from "~/@/lib/sector-images";
import { cn } from "~/@/lib/utils";
import {
  changeOverLag,
  trailingSma,
  trailingZScore,
  type IndustryIntelligenceStory,
} from "~/@/lib/industry-intelligence";

function formatPercent(value: number): string {
  return `${value.toFixed(2)}%`;
}

/**
 * Applies ?industry=&view= deep links after hydration. Lives behind its own
 * Suspense boundary so useSearchParams never bails the page's static shell —
 * the server render stays ISR-cacheable (reading searchParams server-side
 * silently made every request re-run the whole data fan-out).
 */
function DeepLinkSync({
  onApply,
}: {
  onApply: (industry: string | null, view: string | null) => void;
}) {
  const searchParams = useSearchParams();
  const industry = searchParams.get("industry");
  const view = searchParams.get("view");
  useEffect(() => {
    onApply(industry, view);
  }, [industry, onApply, view]);
  return null;
}

/** Terminal-style underline tab trigger (overrides the shadcn pill default). */
const TAB_TRIGGER_CLASSES = cn(
  "min-h-10 rounded-none border-b-2 border-transparent bg-transparent px-1 pb-2.5 pt-1",
  "font-mono text-[0.72rem] uppercase tracking-[0.12em] text-muted-foreground",
  "transition-colors hover:text-foreground",
  "data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none",
);

export function IndustryIntelligenceClient({
  stories,
  initialSlug,
  initialView,
}: {
  stories: IndustryIntelligenceStory[];
  initialSlug?: string;
  initialView?: string;
}) {
  const initialStory = useMemo(
    () =>
      stories.find((story) => story.industry.slug === initialSlug) ??
      stories[0] ??
      null,
    [initialSlug, stories],
  );
  const [selectedSlug, setSelectedSlug] = useState(initialStory?.industry.slug);
  const [view, setView] = useState(() => {
    if (!initialView || !initialStory) return "overview";
    if (initialView === "overview" || initialView === "sources") {
      return initialView;
    }
    return initialStory.channels.some(
      (channel) => `channel-${channel.kind}` === initialView,
    )
      ? initialView
      : "overview";
  });
  const selectedStory = useMemo(
    () =>
      stories.find((story) => story.industry.slug === selectedSlug) ??
      initialStory,
    [initialStory, selectedSlug, stories],
  );

  // Deep links land here post-hydration (the server render is param-free so
  // the route stays ISR-cached). Invalid slugs/views fall back silently.
  const applyDeepLink = useCallback(
    (slugParam: string | null, viewParam: string | null) => {
      const target = slugParam
        ? stories.find((story) => story.industry.slug === slugParam)
        : null;
      if (target) setSelectedSlug(target.industry.slug);
      if (!viewParam) return;
      const scope = target ?? initialStory;
      if (!scope) return;
      const valid =
        viewParam === "overview" ||
        viewParam === "sources" ||
        scope.channels.some((channel) => `channel-${channel.kind}` === viewParam);
      if (valid) setView(viewParam);
    },
    [initialStory, stories],
  );

  const selectIndustry = (slug: string) => {
    setSelectedSlug(slug);
    // Keep the industry shareable/bookmarkable without a navigation.
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("industry", slug);
      window.history.replaceState(null, "", url);
    }
    // A channel tab may not exist for the next industry; fall back home.
    const next = stories.find((story) => story.industry.slug === slug);
    if (
      next &&
      view !== "overview" &&
      view !== "sources" &&
      !next.channels.some((channel) => `channel-${channel.kind}` === view)
    ) {
      setView("overview");
    }
  };

  const { status: sessionStatus } = useSession();

  // Signed-out visitors get the story headline plus a locked teaser: the page
  // stays indexable/ISR (gate is client-side) and the lock names what a free
  // account unlocks.
  if (sessionStatus === "unauthenticated") {
    const industryNames = stories
      .slice(0, 8)
      .map((story) => story.industry.name);
    return (
      <div className="min-w-0" data-testid="industry-intelligence-locked">
        <header className="border-b border-border/60 pb-5">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">
            Industry story
          </p>
          <h1 className="mt-1 font-serif text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            Industry Intelligence
          </h1>
          <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground text-pretty">
            Short-interest crowding and cited public-source evidence for ASX
            industries.
          </p>
        </header>
        <div className="mt-6 flex flex-col gap-4">
          <IntelLockCard
            title="Industry intelligence is a signed-in workspace"
            description="Create a free account to open the full evidence workspace."
            bullets={[
              "Short-interest crowding by industry, week by week",
              "Tax, public money, emissions and trade evidence channels",
              "Per-company drill-downs with cited primary sources",
              "Alert monitors on the signals you care about",
            ]}
            callbackUrl="/industry-intelligence"
            ctaLabel="Sign in to open the workspace"
          />
          {industryNames.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Covers {industryNames.join(", ")}
              {stories.length > industryNames.length ? " and more." : "."}
            </p>
          )}
        </div>
      </div>
    );
  }

  if (!selectedStory) {
    return (
      <div className="rounded-lg border border-border/60 bg-card/80 shadow-amber-sm">
        <div className="border-b border-border/60 px-6 py-5">
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

  const asAt = selectedStory.shortSignals.source.asAt ?? "";

  return (
    <div className="min-w-0" data-testid="industry-intelligence-story">
      <Suspense fallback={null}>
        <DeepLinkSync onApply={applyDeepLink} />
      </Suspense>
      {/* Command bar: one slim header instead of a marketing hero. */}
      <header className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4 border-b border-border/60 pb-5">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-[0.2em] text-primary">
            Industry story
          </p>
          <h1 className="mt-1 font-serif text-3xl font-bold tracking-tight text-balance sm:text-4xl">
            Industry Intelligence
          </h1>
          <p className="mt-1.5 max-w-xl text-sm leading-6 text-muted-foreground text-pretty">
            Short-interest crowding and cited public-source evidence for ASX
            industries.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-2 hidden font-mono text-xs tabular-nums text-muted-foreground md:inline">
            ASIC daily, T+4 · as at {asAt}
          </span>
          <EvidenceExportButton
            industryName={selectedStory.industry.name}
            industrySlug={selectedStory.industry.slug}
            channels={selectedStory.channels}
          />
          <Button asChild className="min-h-10">
            <Link
              href={`/alerts?industry=${selectedStory.industry.slug}`}
              prefetch={false}
            >
              <AlertCircle className="mr-2 h-4 w-4" aria-hidden="true" />
              Create alert
            </Link>
          </Button>
        </div>
      </header>

      <div className="grid min-w-0 gap-x-10 gap-y-6 pt-6 lg:grid-cols-[230px_minmax(0,1fr)]">
        <IndustrySidenav
          stories={stories}
          selectedSlug={selectedStory.industry.slug}
          onSelect={selectIndustry}
        />

        <main className="min-w-0">
          <Tabs value={view} onValueChange={setView} className="min-w-0">
            <TabsList className="h-auto w-full justify-start gap-x-5 overflow-x-auto rounded-none border-b border-border/60 bg-transparent p-0">
              <TabsTrigger value="overview" className={TAB_TRIGGER_CLASSES}>
                Overview
              </TabsTrigger>
              {selectedStory.channels.map((channel) => (
                <TabsTrigger
                  key={channel.kind}
                  value={`channel-${channel.kind}`}
                  className={TAB_TRIGGER_CLASSES}
                >
                  {channel.label}
                </TabsTrigger>
              ))}
              <TabsTrigger value="sources" className={TAB_TRIGGER_CLASSES}>
                Sources
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="overview"
              className="mt-6 space-y-8 motion-safe:animate-fade-in"
            >
              <OverviewPanel story={selectedStory} />
            </TabsContent>

            {selectedStory.channels.map((channel) => (
              <TabsContent
                key={channel.kind}
                value={`channel-${channel.kind}`}
                className="mt-6 motion-safe:animate-fade-in"
              >
                <ChannelDetail channel={channel} />
              </TabsContent>
            ))}

            <TabsContent
              value="sources"
              className="mt-6 motion-safe:animate-fade-in"
            >
              <IndustryMethodology
                channels={selectedStory.channels}
                asAt={asAt}
              />
            </TabsContent>
          </Tabs>
        </main>
      </div>
    </div>
  );
}

/**
 * The industry instrument list: primary navigation for the workspace.
 * Vertical rail on lg+, horizontal scroll row below.
 */
function IndustrySidenav({
  stories,
  selectedSlug,
  onSelect,
}: {
  stories: IndustryIntelligenceStory[];
  selectedSlug: string;
  onSelect: (slug: string) => void;
}) {
  return (
    <nav
      aria-label="Industries"
      data-testid="industry-sidenav"
      className="min-w-0 lg:sticky lg:top-20 lg:self-start"
    >
      <div className="mb-2 hidden items-baseline justify-between lg:flex">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Industries
        </h2>
        <Link
          href="/industry"
          prefetch={false}
          className="text-[11px] text-muted-foreground transition-colors hover:text-primary"
        >
          All
          <ArrowUpRight
            className="ml-0.5 inline h-2.5 w-2.5"
            aria-hidden="true"
          />
        </Link>
      </div>
      <ul className="flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:pb-0">
        {stories.map((story) => {
          const selected = story.industry.slug === selectedSlug;
          return (
            <li key={story.industry.slug} className="shrink-0 lg:shrink">
              <button
                type="button"
                aria-pressed={selected}
                onClick={() => onSelect(story.industry.slug)}
                className={cn(
                  "flex min-h-10 w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 lg:whitespace-normal",
                  selected
                    ? "bg-primary/10 font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
              >
                <Image
                  src={getSectorImagePath(story.industry.name)}
                  alt={getSectorImageAlt(story.industry.name)}
                  width={18}
                  height={18}
                  className="h-[18px] w-[18px] shrink-0 object-contain"
                />
                <span className="min-w-0 flex-1 truncate leading-5">
                  {story.industry.name}
                </span>
                <span
                  className={cn(
                    "shrink-0 font-mono text-xs tabular-nums",
                    selected ? "text-primary" : "text-muted-foreground/70",
                  )}
                >
                  {formatPercent(story.industry.avgShortPercent)}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function OverviewPanel({ story }: { story: IndustryIntelligenceStory }) {
  const leader = story.topShortedStocks[0] ?? null;

  return (
    <>
      {/* Signal band: hairline-separated figures, no card chrome. */}
      <section aria-label={`${story.industry.name} signal summary`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="min-w-0 truncate text-xl font-semibold tracking-tight">
            {story.industry.name}
          </h2>
          <span className="text-xs text-muted-foreground">
            Source: ASIC short position reports,{" "}
            {story.shortSignals.source.cadence}
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-border/60 bg-border/60 sm:grid-cols-5">
          <SignalCell
            label="Average short"
            value={formatPercent(story.shortSignals.averageShortPercent)}
            emphasis
          />
          <SignalCell
            label="Tracked"
            value={String(story.industry.stockCount)}
            detail="ASX stocks"
          />
          <SignalCell
            label="Highly shorted"
            value={String(story.shortSignals.highlyShortedCount)}
            detail="above 10%"
          />
          <SignalCell
            label="Rising"
            value={String(story.shortSignals.risingCount)}
            detail="panel change"
          />
          <SignalCell
            label="Lead short"
            value={leader ? leader.code : "—"}
            detail={leader ? formatPercent(leader.shortPercent) : "no data"}
          />
        </dl>
      </section>

      {story.crowding ? <CrowdingSection story={story} /> : null}

      <IndustrySignalPanel story={story} stockLimit={10} id="top-shorts" />

      {/* Alert funnel: one quiet, purposeful strip — not another card grid. */}
      <aside
        id="alerts"
        aria-label="Alerts"
        className="flex flex-wrap items-center justify-between gap-4 rounded-md border border-primary/25 bg-primary/5 px-5 py-4"
      >
        <p className="min-w-0 max-w-xl text-sm leading-6 text-pretty">
          <span className="font-medium">
            Track {story.industry.name} daily or weekly.
          </span>{" "}
          <span className="text-muted-foreground">
            Get notified when short interest moves across the sector.
          </span>
        </p>
        <div className="flex shrink-0 gap-2">
          <Button asChild className="min-h-10">
            <Link
              href={`/alerts?industry=${story.industry.slug}`}
              prefetch={false}
            >
              Create daily alert
            </Link>
          </Button>
          <Button asChild variant="ghost" className="min-h-10">
            <Link href={`/industry/${story.industry.slug}`} prefetch={false}>
              Review industry
              <ArrowUpRight className="ml-1.5 h-3.5 w-3.5" aria-hidden="true" />
            </Link>
          </Button>
        </div>
      </aside>
    </>
  );
}

type CrowdingWindowKey = "3m" | "6m" | "1y" | "2y";
type CrowdingViewKey = "level" | "momentum" | "zscore";
type CrowdingCenterKey = "avg" | "median";
type CrowdingBandKey = "p10p90" | "iqr" | "none";

const CROWDING_WINDOW_DAYS: Record<CrowdingWindowKey, number> = {
  "3m": 91,
  "6m": 182,
  "1y": 365,
  "2y": 731,
};
const CROWDING_SMA_WEEKS = 4;
const CROWDING_MOMENTUM_WEEKS = 4;
const CROWDING_ZSCORE_WEEKS = 26;

const CROWDING_VIEW_COPY: Record<
  CrowdingViewKey,
  (center: string, band: string | null) => string
> = {
  level: (center, band) =>
    `Weekly constituent ${center}${band ? ` with the ${band} dispersion band` : ""}.`,
  momentum: (center) =>
    `${CROWDING_MOMENTUM_WEEKS}-week change in the weekly constituent ${center}, in percentage points.`,
  zscore: (center) =>
    `Weekly constituent ${center} scored against its trailing ${CROWDING_ZSCORE_WEEKS}-week distribution.`,
};

function CrowdingSection({ story }: { story: IndustryIntelligenceStory }) {
  const [windowKey, setWindowKey] = useState<CrowdingWindowKey>("3m");
  const [view, setView] = useState<CrowdingViewKey>("level");
  const [center, setCenter] = useState<CrowdingCenterKey>("avg");
  const [band, setBand] = useState<CrowdingBandKey>("p10p90");
  const [smooth, setSmooth] = useState(false);

  const points = useMemo(
    () => story.crowding?.points ?? [],
    [story.crowding],
  );
  // Older ISR payloads predate the median/quartile fields — fall back to the
  // mean-only chart until the next revalidation delivers them.
  const hasExtendedStats = points.every(
    (p) => p.median != null && p.p25 != null && p.p75 != null,
  );

  const chart = useMemo(() => {
    if (points.length === 0) return null;
    const useMedian = center === "median" && hasExtendedStats;
    const centers = points.map((p) =>
      useMedian ? p.median! : p.avg,
    );
    // Derive on the full series first so windowed views keep their history
    // (an SMA/momentum/z-score left edge sliced after derivation, not before).
    const overlay = smooth ? trailingSma(centers, CROWDING_SMA_WEEKS) : null;
    const momentum = changeOverLag(centers, CROWDING_MOMENTUM_WEEKS);
    const zscore = trailingZScore(centers, CROWDING_ZSCORE_WEEKS);

    const lastDate = points[points.length - 1]!.date;
    const cutoff = new Date(`${lastDate}T00:00:00Z`);
    cutoff.setUTCDate(cutoff.getUTCDate() - CROWDING_WINDOW_DAYS[windowKey]);
    const cutoffIso = cutoff.toISOString().slice(0, 10);

    const rendered = points
      .map((p, i) => ({
        date: p.date,
        value:
          (view === "level"
            ? centers[i]
            : view === "momentum"
              ? momentum[i]
              : zscore[i]) ?? null,
        bandLo:
          view === "level" && band !== "none"
            ? band === "iqr"
              ? p.p25
              : p.p10
            : undefined,
        bandHi:
          view === "level" && band !== "none"
            ? band === "iqr"
              ? p.p75
              : p.p90
            : undefined,
        overlay: view === "level" && overlay ? overlay[i] : undefined,
        constituents: p.constituents,
      }))
      .filter((p) => p.date >= cutoffIso);

    const latestValue = [...rendered]
      .reverse()
      .find((p) => p.value != null)?.value;

    return { rendered, latestValue, useMedian };
  }, [band, center, hasExtendedStats, points, smooth, view, windowKey]);

  if (!story.crowding || !chart) return null;

  const centerLabel = chart.useMedian ? "Median" : "Average";
  const bandLabel =
    view === "level" && band !== "none"
      ? band === "iqr"
        ? "p25–p75"
        : "p10–p90"
      : null;
  const latestDisplay =
    chart.latestValue == null
      ? "—"
      : view === "level"
        ? formatPercent(chart.latestValue)
        : view === "momentum"
          ? `${chart.latestValue > 0 ? "+" : ""}${chart.latestValue.toFixed(2)}pp`
          : `${chart.latestValue > 0 ? "+" : ""}${chart.latestValue.toFixed(2)}σ`;

  return (
    <section
      id="crowding"
      aria-labelledby="crowding-heading"
      data-testid="industry-crowding-card"
      className="min-w-0"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <div className="min-w-0">
          <h2
            id="crowding-heading"
            className="text-base font-semibold tracking-tight"
          >
            Short-interest crowding
          </h2>
          <p className="text-xs leading-5 text-muted-foreground">
            {CROWDING_VIEW_COPY[view](centerLabel.toLowerCase(), bandLabel)}
          </p>
        </div>
        <span className="font-mono text-sm tabular-nums">
          <span className="text-muted-foreground">latest week</span>{" "}
          <span className="font-semibold">{latestDisplay}</span>
        </span>
      </div>

      {/* Controls: one row above the chart; every cluster wraps on mobile. */}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <SegmentedToggle<CrowdingViewKey>
          ariaLabel="Statistic"
          options={[
            { value: "level", label: "Level" },
            { value: "momentum", label: "Momentum" },
            { value: "zscore", label: "Z-score" },
          ]}
          value={view}
          onChange={setView}
        />
        {hasExtendedStats ? (
          <SegmentedToggle<CrowdingCenterKey>
            ariaLabel="Center line"
            options={[
              { value: "avg", label: "Mean" },
              { value: "median", label: "Median" },
            ]}
            value={center}
            onChange={setCenter}
          />
        ) : null}
        {view === "level" ? (
          <>
            {hasExtendedStats ? (
              <SegmentedToggle<CrowdingBandKey>
                ariaLabel="Dispersion band"
                options={[
                  { value: "p10p90", label: "10–90" },
                  { value: "iqr", label: "25–75" },
                  { value: "none", label: "No band" },
                ]}
                value={band}
                onChange={setBand}
              />
            ) : null}
            <button
              type="button"
              onClick={() => setSmooth((v) => !v)}
              aria-pressed={smooth}
              className={cn(
                "inline-flex min-h-8 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                smooth
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              )}
            >
              <span
                aria-hidden="true"
                className="inline-block h-0 w-4 border-t-2 border-dashed border-primary"
              />
              SMA {CROWDING_SMA_WEEKS}w
            </button>
          </>
        ) : null}
        <div className="ms-auto">
          <SegmentedToggle<CrowdingWindowKey>
            ariaLabel="Time window"
            options={[
              { value: "3m", label: "3M" },
              { value: "6m", label: "6M" },
              { value: "1y", label: "1Y" },
              { value: "2y", label: "2Y" },
            ]}
            value={windowKey}
            onChange={setWindowKey}
          />
        </div>
      </div>

      <div className="mt-3" style={{ minHeight: 268 }}>
        <IndustryCrowdingChart
          points={chart.rendered}
          industryName={story.industry.name}
          mode={view}
          centerLabel={centerLabel}
          bandLabel={bandLabel}
          overlayLabel={smooth && view === "level" ? `SMA ${CROWDING_SMA_WEEKS}w` : null}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Weeks with fewer than three reporting constituents are omitted.
        {view === "zscore"
          ? " Dashed guides mark ±1σ."
          : ""}
      </p>
    </section>
  );
}

function SignalCell({
  label,
  value,
  detail,
  emphasis = false,
}: {
  label: string;
  value: string;
  detail?: string;
  emphasis?: boolean;
}) {
  return (
    <div className="min-w-0 bg-card px-4 py-3.5">
      <dt className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 break-words font-mono text-xl font-semibold tabular-nums",
          emphasis && "text-primary",
        )}
      >
        {value}
      </dd>
      {detail ? (
        <dd className="mt-0.5 text-[11px] text-muted-foreground">{detail}</dd>
      ) : null}
    </div>
  );
}
