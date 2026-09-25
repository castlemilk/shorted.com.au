// NO "use client" — this is the server-rendered body of /housing/[state]/[suburb].
//
// It used to be a client component behind dynamic({ssr:false}), which meant every
// one of the ~3,600 suburb URLs advertised in the sitemap served a 520px grey
// skeleton: no <h1>, no price, no demographics in the HTML. The profile was
// already fetched on the server and then thrown at the client to re-render.
//
// So the rule here is: anything that can be computed from the data the server
// already holds is rendered on the server. That now includes the state ranks,
// the distribution curves and the nearby list — all derived from the state suburb
// index the page fetches (see lib/housing/suburb-stats), which retired the old
// idle-deferred 5,000-row client fetch entirely.
//
// Only two things stay client-side, each as its own island, and each for a
// stated reason:
//   - HousingSeriesChart / SuburbLocatorMap — pull connect-web in, which breaks
//     SSR (see CLAUDE.md), so they load via dynamic({ssr:false}) wrappers.
//   - RecentPriceDrops — crawl-derived and kill-switchable, so it must re-read
//     at request time rather than bake into a 24h ISR page.
//
// Keep it that way: adding a hook or a client-action import to this file silently
// drags the whole body back out of the HTML.
//
// One editorial rule governs every number below: say what the source says, and
// rank only against a population we can name. Nothing here averages unlike
// measures into a composite score.
import { type ReactNode } from "react";
import { SuburbPoliticianPropertyCard } from "@/components/politicians/suburb-politician-property-card-loader";
import Link from "next/link";
import type {
  GetSuburbProfileResponse,
  SuburbCrime,
  SuburbDemographics,
  SuburbSeifa,
  SuburbSeifaIndex,
  SuburbSummary,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { HousingSeriesChart } from "./housing-charts";
import { SuburbBanner } from "./suburb-banner";
import { SuburbDistributionPanels } from "./suburb-distribution-card";
import { SuburbListingEstimate } from "./suburb-listing-estimate";
import { SuburbLocatorMap } from "./suburb-locator-map";
import { SuburbNearbyList } from "./suburb-nearby-list";
import { SuburbScoreBand } from "./suburb-score-band";
import { SuburbHazardCard } from "./suburb-hazard-card";
import { SuburbCouncilCard } from "./suburb-council-card";
import { SuburbPlanningCard } from "./suburb-planning-card";
import { PLANNING_SOURCE_CREDITS, planningCreditIds } from "@/lib/housing/planning-sources";
import { SuburbHousingStockCard, SuburbWhoLivesHereCard } from "./suburb-household-card";
import { RecentPriceDrops } from "./suburb-recent-price-drops-loader";
import { STATE_NAMES, splitSalName, stateSlug, suburbHref, titleCaseName } from "@/lib/housing/states";
import { crimeRankScale, publishableNbnTech } from "@/lib/housing/highlight-metrics";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { priceSeriesGap } from "@/lib/housing/price-coverage";
import { CAPITALS } from "@/lib/housing/capitals";
import { ordinal, type SuburbContext } from "@/lib/housing/suburb-stats";
import type { SuburbPageGeometry } from "@/lib/housing/suburb-geometry.server";
import { HousingIcon, type HousingIconName } from "./housing-icon";

const fmtAUD = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`;
const fmtMoney = (v: number) => `$${Math.round(v).toLocaleString()}`;

function fmtPeriod(seconds?: number | bigint): string | null {
  const n = Number(seconds ?? 0);
  if (!n) return null;
  return new Date(n * 1000).toLocaleDateString("en-AU", { month: "short", year: "numeric" });
}

export type SuburbProfileProps = {
  salCode: string;
  regionCode?: string;
  stateCode?: string;
  profile?: GetSuburbProfileResponse;
  /** State ranks, distributions and neighbours, derived in the page. */
  context?: SuburbContext;
  /** Server-projected boundary paths (banner inset, state locator); null hides both maps. */
  geometry?: SuburbPageGeometry | null;
};

export function SuburbProfile({
  salCode, regionCode, stateCode, profile, context, geometry,
}: SuburbProfileProps) {
  const data = profile;
  const st = stateCode ?? data?.summary?.stateCode ?? "";
  const s = data?.summary;

  if (!data?.summary || !s) {
    return (
      <div className="rounded-xl border border-border bg-card p-8 text-center text-sm text-muted-foreground">
        No data for this suburb yet.{" "}
        {st ? <Link href={`/housing/${stateSlug(st)}`} className="text-foreground underline">Back to {STATE_NAMES[st]}</Link> : null}
      </div>
    );
  }
  const d = data.demographics, b = data.baselines;
  // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- proto string fields default to "" which must fall through
  const regionForSeries = s.regionCode || regionCode;
  const priced = s.latestMedianPrice > 0;
  // The backend hands back a region IDENTITY for suburbs that have no published
  // observation, so `regionCode` alone is not evidence of a price series. Gating
  // the chart on it made QLD and WA suburbs — states with no Valuer-General feed
  // at all — render a "Rolling median of settled transfers, state Valuer-General
  // open data" caption directly under a banner reading "Median house price not
  // tracked for this suburb". Only a real latest median proves a series exists.
  const chartRegion = priced ? regionForSeries : undefined;
  const asOf = fmtPeriod(s.latestPeriod?.seconds);
  const stateName = STATE_NAMES[st] ?? s.stateCode;
  // The h1 carries the place; ABS's "(Qld)"-style qualifier only disambiguates
  // repeated names, and the subtitle already names the state, so only an LGA
  // part of it ("Glenroy (Albury - NSW)" → Albury) moves into the subtitle.
  const { place, region } = splitSalName(s.salName);
  const priceGap = priceSeriesGap(st, stateName, s.salName);
  const a = s.amenities;

  // Price references: ABS established-house medians for the state's capital and
  // the rest of the state. There is no open national median house price, so no
  // "AU" price tick (the old one averaged NSW, VIC and SA suburbs).
  const capitalSlug = CAPITALS.find((c) => c.regionCode === b?.capitalRegionCode)?.slug;
  const priceRefs: CompareRef[] = [];
  if (b?.capitalMedianPrice) {
    const short = b.capitalRegionName.replace(/^Greater /, "");
    priceRefs.push({
      tick: short.length > 12 ? st : short, label: b.capitalRegionName, value: b.capitalMedianPrice,
      href: capitalSlug ? `/housing/capitals/${capitalSlug}` : undefined,
    });
  }
  if (b?.restOfStateMedianPrice) {
    priceRefs.push({ tick: "Rest of state", label: b.restOfStateRegionName, value: b.restOfStateMedianPrice, dashed: true });
  }
  const incomeRefs: CompareRef[] = [
    { tick: st, label: `${st} median suburb`, value: b?.stateMedianWeeklyHhdIncome ?? 0, href: st ? `/housing/${stateSlug(st)}` : undefined },
    { tick: "AU", label: "AU median suburb", value: b?.nationalMedianWeeklyHhdIncome ?? 0, href: "/housing", dashed: true },
  ];

  const repaymentsHref = priced
    ? `/housing/calculators?price=${Math.round(s.latestMedianPrice)}${st ? `&state=${st}` : ""}`
    : undefined;

  const incomeDelta = (value: number, base?: number) =>
    value > 0 && base && base > 0
      ? { text: `${value >= base ? "▲" : "▼"} ${Math.abs(Math.round((value / base - 1) * 100))}% vs ${st}`, positive: value >= base }
      : undefined;

  // Dwellings, tenure and the Census household mix live in the Housing stock and
  // Who lives here cards below. No "Born overseas" here either — CultureCard
  // owns the cultural figures, and it was appearing in both.
  const peopleTiles: Tile[] = [
    { label: "Population", value: d?.population ? d.population.toLocaleString() : "—", icon: "population" },
    { label: "Median age", value: d?.medianAge ? `${d.medianAge} yrs` : "—", icon: "age" },
    { label: "Income / person / wk", value: d?.medianWeeklyPerIncome ? fmtMoney(d.medianWeeklyPerIncome) : "—", icon: "income" },
    {
      label: "Household income / wk",
      value: d?.medianWeeklyHhdIncome ? fmtMoney(d.medianWeeklyHhdIncome) : "—",
      icon: "income",
      delta: incomeDelta(d?.medianWeeklyHhdIncome ?? 0, b?.stateMedianWeeklyHhdIncome),
    },
    { label: "Median rent / wk", value: d?.medianWeeklyRent ? fmtMoney(d.medianWeeklyRent) : "—", icon: "rent" },
    { label: "Mortgage / month", value: d?.medianMonthlyMortgage ? fmtMoney(d.medianMonthlyMortgage) : "—", icon: "mortgage" },
  ];

  const hasComparison =
    Boolean(context?.priceDist ?? context?.incomeDist) ||
    priced ||
    (d?.medianWeeklyHhdIncome ?? 0) > 0;

  return (
    <div className="space-y-6">
      <SuburbBanner
        name={place}
        sub={`${region ? `${region} · ` : ""}${stateName}${s.postcode ? ` · ${s.postcode}` : ""}${d?.censusYear ? ` · Census ${d.censusYear}` : ""}`}
        stat={priced ? fmtAUD(s.latestMedianPrice) : undefined}
        statDelta={priced && s.yoyPct !== 0
          ? { text: `${s.yoyPct >= 0 ? "+" : ""}${s.yoyPct.toFixed(1)}% yr`, positive: s.yoyPct >= 0 }
          : undefined}
        statNote={priced ? `median house${asOf ? ` · ${asOf}` : ""}` : undefined}
        statSub={priced ? undefined : "Median house price not tracked for this suburb"}
        banner={data.banner ? {
          archetype: data.banner.archetype,
          blurb: data.banner.blurb,
          bgKey: data.banner.bgKey,
          bgUrl: data.banner.bgUrl || undefined,
        } : undefined}
        locator={geometry?.locator}
      />

      <SuburbScoreBand
        stateCode={st}
        price={context?.price ?? null}
        priceValue={priced ? fmtAUD(s.latestMedianPrice) : ""}
        income={context?.income ?? null}
        incomeValue={d?.medianWeeklyHhdIncome ? `${fmtMoney(d.medianWeeklyHhdIncome)}/wk` : ""}
        amenity={context?.amenity ?? null}
        amenityValue={a?.amenityDensityScore ? `${Math.round(a.amenityDensityScore)}/100` : ""}
      />

      {/* No chip row here any more. It restated the three ranks in the band one
          line above it, word for word — "Dearer than 97% of priced NSW suburbs"
          beside "98th pctile of 2,433 priced NSW suburbs" — and its only
          non-rank fact, distance to coast, already has an amenities tile. What
          is left is the one thing the band cannot carry: the way out. */}
      {repaymentsHref ? (
        <Link
          href={repaymentsHref}
          className="hit-target inline-flex items-center text-xs text-primary transition-colors hover:text-foreground"
        >
          Estimate repayments for this suburb →
        </Link>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* main column */}
        <div className="min-w-0 space-y-10">
          {/* price chart or empty-state. The headline figure lives in the banner
              and is deliberately not repeated here. */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="flex items-center gap-2.5 font-serif text-2xl text-foreground">
              <HousingIcon name="median-price" size={24} /> Median house price
            </h2>
            {chartRegion ? (
              <>
                <div className="mt-3">
                  <HousingSeriesChart regionCode={chartRegion} measure="median_price" dwellingType="house" ariaLabel={`${s.salName} median house price`} format="aud" height={280} />
                </div>
                <p className="mt-3 text-[11px] text-muted-foreground">
                  Rolling median of settled transfers, state Valuer-General open data (CC BY 4.0).
                  {b?.stateMedianPrice ? ` Median of ${stateName} suburb medians: ${fmtPriceShort(b.stateMedianPrice)}.` : ""}
                </p>
              </>
            ) : (
              <>
                <div className="flex flex-col items-center justify-center gap-1 py-8 text-center text-sm text-muted-foreground">
                  <p>{priceGap.headline}</p>
                  <p className="text-xs [text-wrap:pretty]">{priceGap.detail}{b?.capitalMedianPrice ? ` ABS median established-house price, ${b.capitalRegionName}: ${fmtPriceShort(b.capitalMedianPrice)}${b.restOfStateMedianPrice ? `; ${b.restOfStateRegionName}: ${fmtPriceShort(b.restOfStateMedianPrice)}` : ""}.` : ""}</p>
                </div>
                {/* The only price signal these suburbs have. Rendered here, and
                    only here, so it can never sit beside an official median. */}
                <SuburbListingEstimate
                  stats={data.listingStats}
                  suburbName={s.salName}
                  fmt={fmtAUD}
                />
              </>
            )}
          </div>

          {/* Distribution and baselines are the same question — where does this
              sit — so they are one section, immediately after the series. */}
          {hasComparison ? (
            <div className="rounded-xl border border-border bg-card p-5">
              <h2 className="flex items-center gap-2.5 font-serif text-2xl text-foreground">
                <HousingIcon name="compare" size={24} /> How it compares
              </h2>
              {context ? (
                <div className="mt-4">
                  <SuburbDistributionPanels
                    priceDist={context.priceDist}
                    pricePct={context.price?.pct ?? null}
                    incomeDist={context.incomeDist}
                    incomePct={context.income?.pct ?? null}
                    fmtPrice={fmtPriceShort}
                    fmtIncome={fmtMoney}
                    censusYear={d?.censusYear}
                  />
                </div>
              ) : null}
              <div className="mt-6 flex flex-col gap-5">
                {priced ? (
                  <CompareBar
                    label="Median house price" name={s.salName} suburb={s.latestMedianPrice}
                    refs={priceRefs} fmt={fmtAUD} showDeltas
                  />
                ) : null}
                <CompareBar
                  label="Household income / wk" name={s.salName} suburb={d?.medianWeeklyHhdIncome ?? 0}
                  refs={incomeRefs} fmt={fmtMoney}
                />
              </div>
              <p className="mt-4 text-[11px] text-muted-foreground [text-wrap:pretty]">
                Percentiles rank this suburb against {stateName} suburbs that carry the metric —
                never across states, and never against suburbs where it is missing.
                {priceRefs.length > 0 ? (
                  <>
                    {" "}Price references are ABS median established-house transfer prices
                    {b?.absMedianPeriod ? ` for the ${quarterLabel(b.absMedianPeriod)} quarter` : ""} (CC BY 4.0);
                    the suburb figure is a Valuer-General median over a different window, so read
                    the gap as indicative.
                  </>
                ) : null}
                {" "}Income references are the Census 2021 median of the middle suburb in {stateName} and
                nationally, not a household-weighted median.
              </p>
            </div>
          ) : null}

          {/* people & housing */}
          {peopleTiles.some((t) => t.value !== "—") ? (
            <section>
              <SectionHeading icon="population">People &amp; housing</SectionHeading>
              <TileGrid tiles={peopleTiles} />
            </section>
          ) : null}

          <SuburbWhoLivesHereCard d={d} state={b?.stateCensus} stateCode={st} />
          <SuburbHousingStockCard d={d} state={b?.stateCensus} stateCode={st} />

          <SeifaProfile seifa={s.seifa} stateName={stateName} />

          <SuburbHazardCard elevation={data.elevation} hazards={data.hazards} stateCode={st} salCode={s.salCode} />

          <SuburbPlanningCard planning={data.planning} stateCode={st} salCode={s.salCode} />

          {a ? <AmenitiesGroup a={a} nbn={publishableNbnTech(s.dominantNbnTech, d?.population ?? 0) ?? undefined} /> : null}

          <div className="grid gap-6 sm:grid-cols-2">
            {d ? <CultureCard d={d} /> : null}
            {a ? <SchoolSectorCard a={a} /> : null}
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            {data.council?.lgaName ? <SuburbCouncilCard council={data.council} overlaps={data.councilOverlaps} /> : null}
            <FederalRep s={s} />
          </div>

          <CrimeCard crime={data.crime} />

          {/* Last in the column on purpose: it is an ssr:false island that renders
              nothing when the suburb has no declarations, so anything below it
              would jump on hydration. */}
          <SuburbPoliticianPropertyCard salCode={salCode} />
        </div>

        {/* right rail */}
        <div className="min-w-0 space-y-5">
          {st ? (
            <SuburbLocatorMap stateCode={st} salCode={s.salCode} salName={s.salName} model={geometry?.stateLocator} />
          ) : null}

          {st && context ? (
            <SuburbNearbyList stateCode={st} nearby={context.nearby} basis={context.nearbyBasis} />
          ) : null}

          {data.similar?.length ? (
            <div className="rounded-xl border border-border bg-card p-4">
              <h3 className="mb-1 flex items-center gap-1.5 font-serif text-base text-foreground">
                <HousingIcon name="similar" size={22} /> Similar suburbs
              </h3>
              <p className="mb-2 text-[11px] text-muted-foreground">Closest demographic &amp; amenity profile, nationally.</p>
              <div className="flex flex-col">
                {data.similar.map((n) => (
                  <Link key={n.salCode} href={suburbHref(n.stateCode, { salName: n.salName, salCode: n.salCode, postcode: "" })}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
                    <span className="truncate">
                      {n.salName} <span className="text-[10px] uppercase text-muted-foreground">{n.stateCode}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums">
                      {n.latestMedianPrice > 0 ? fmtPriceShort(n.latestMedianPrice) : `${Math.round(n.similarity * 100)}% match`}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          {/* Crawl-derived listings, unrelated to the Valuer-General series, so
              this keeps the raw region identity rather than the priced-only one. */}
          <RecentPriceDrops salCode={s.salCode} regionCode={regionForSeries} />
        </div>
      </div>

      <SourcesLine
        censusYear={d?.censusYear}
        hasCensus={Boolean(d?.population ?? d?.medianWeeklyHhdIncome)}
        hasPrice={priced}
        hasAmenities={Boolean(a?.schoolsTotal ?? a?.supermarketsTotal ?? a?.parksCount)}
        hasSchoolSectors={Boolean(a && a.schoolsGov + a.schoolsCatholic + a.schoolsIndependent > 0)}
        hasFederal={Boolean(s.federalDivision)}
        hasStateMember={Boolean(s.stateMember)}
        hasTerrain={data.elevation?.elevationMedianM !== undefined}
        hasWaterObservations={data.hazards?.waterObservedSharePct !== undefined}
        statutoryHazardSources={[data.hazards?.floodSource, data.hazards?.bushfireSource].filter(Boolean) as string[]}
        planningSources={planningCreditIds(data.planning)}
        stateName={stateName}
      />
    </div>
  );
}

type Demographics = SuburbDemographics;

type Summary = SuburbSummary;
type Crime = SuburbCrime;

type SeifaIndexDefinition = {
  code: "IRSAD" | "IRSD" | "IER" | "IEO";
  name: string;
  description: string;
  value?: SuburbSeifaIndex;
  headline?: boolean;
};

const hasSeifaValue = (value?: SuburbSeifaIndex) =>
  Boolean(value && (value.score > 0 || value.decileAus > 0 || value.decileState > 0));

export function SeifaProfile({
  seifa,
  stateName,
}: {
  seifa: SuburbSeifa | undefined;
  stateName: string;
}) {
  if (!seifa) return null;

  const indexes: SeifaIndexDefinition[] = [
    {
      code: "IRSAD",
      name: "Relative Socio-economic Advantage and Disadvantage",
      description: "Measures relative socio-economic advantage and disadvantage.",
      value: seifa.irsad,
      headline: true,
    },
    {
      code: "IRSD",
      name: "Relative Socio-economic Disadvantage",
      description: "Measures relative socio-economic disadvantage only; a higher score means less disadvantage.",
      value: seifa.irsd,
    },
    {
      code: "IER",
      name: "Economic Resources",
      description: "Measures access to economic resources, including income, housing costs and assets.",
      value: seifa.ier,
    },
    {
      code: "IEO",
      name: "Education and Occupation",
      description: "Measures relative education and occupation characteristics.",
      value: seifa.ieo,
    },
  ];
  const shownIndexes = indexes.filter((index) => hasSeifaValue(index.value));

  if (shownIndexes.length === 0) return null;

  return (
    <section>
      <SectionHeading icon="compare">Socio-economic profile</SectionHeading>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {shownIndexes.map(({ code, name, description, value, headline }) => {
          if (!value) return null;
          const headingId = `seifa-${code.toLowerCase()}-heading`;
          return (
            <article
              key={code}
              aria-labelledby={headingId}
              className={`rounded-lg border border-border bg-card p-4 ${headline ? "sm:col-span-2 sm:p-5" : ""}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-1">
                <div>
                  <h3 id={headingId} className="font-mono text-base font-semibold text-foreground">
                    {code}
                  </h3>
                  <p className="text-xs font-medium text-foreground">{name}</p>
                </div>
                {value.score > 0 ? (
                  <p className="font-mono text-xs tabular-nums text-muted-foreground">
                    Score <span className="font-semibold text-foreground">{value.score.toLocaleString()}</span>
                  </p>
                ) : null}
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground [text-wrap:pretty]">{description}</p>
              <div className={`mt-3 grid gap-3 ${headline ? "sm:grid-cols-2" : ""}`}>
                <SeifaDecileBar label="Within Australia" decile={value.decileAus} />
                <SeifaDecileBar label={`Within ${stateName}`} decile={value.decileState} />
              </div>
            </article>
          );
        })}
      </div>
      <p className="mt-2.5 text-[11px] text-muted-foreground [text-wrap:pretty]">
        Scores are standardised across Australia to a mean of 1,000 and a standard deviation of 100.
        Deciles run from 1 (most disadvantaged) to 10 (least disadvantaged).
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Source: ABS SEIFA 2021 (CC BY 4.0).
      </p>
    </section>
  );
}

function SeifaDecileBar({ label, decile }: { label: string; decile: number }) {
  if (decile <= 0) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="shrink-0 font-mono font-semibold tabular-nums text-foreground">
          Decile {decile} of 10
        </span>
      </div>
      <div aria-hidden="true">
        <FilledMetricTrack fillPercent={decile * 10}>
          <Baseline label="5" left="50%" dashed />
        </FilledMetricTrack>
      </div>
    </div>
  );
}

const CRIME_LABELS: Record<string, string> = {
  break_ins: "Break-ins",
  violent: "Violent crime",
  motor_vehicle: "Car theft",
  property_damage: "Property damage",
};
/** A type the table above has not caught up with still reads as a label
 * ("Fraud"), not as a raw key in lower case. */
const crimeLabel = (type: string) => {
  const fallback = type.replace(/_/g, " ");
  return CRIME_LABELS[type] ?? fallback.charAt(0).toUpperCase() + fallback.slice(1);
};
const fyLabel = (fy: number) => `FY${fy - 1}–${String(fy).slice(2)}`;

/**
 * Ink for a chip whose background is the fixed d3 YlOrRd crime ramp — a
 * theme-independent swatch, so the ink has to be a literal too. Picked by the
 * swatch's own relative luminance rather than a magic percentile threshold: the
 * previous `pctRank > 65 ? white : black` flipped to white around #FC5B2E, where
 * white is 3.15:1 and black is 6.68:1.
 */
function chipInk(css: string): string {
  const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(css);
  if (!m) return "#0C0C0C";
  const lin = [m[1], m[2], m[3]].map((v) => {
    const c = Number(v) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
  const onBlack = (L + 0.05) / 0.05;
  const onWhite = 1.05 / (L + 0.05);
  return onBlack >= onWhite ? "#0C0C0C" : "#FDFDFC";
}

/** Crime & safety — latest 2-yr-pooled, CVS-adjusted stats. Renders nothing
 * when the suburb has no reliable data (uncovered state, TAS/NT, or a
 * small-population/unreliable suburb gated server-side) — never zeros.
 *
 * Each offence type keeps its own rate and its own percentile. They are never
 * averaged into an overall "safety" figure: no source publishes one, and the
 * three types are counted under different rules. */
export function CrimeCard({ crime }: { crime: Crime | undefined }) {
  const stats = crime?.stats ?? [];
  if (stats.length === 0) return null;
  const fy = stats[0]!.fyEnding;
  const rankScale = crimeRankScale();
  return (
    <section>
      <SectionHeading icon="dwellings">Crime &amp; safety</SectionHeading>
      {/* Four types (property damage joined the three originals) sit 2×2 then
          in one row; a 3-column grid left the fourth card alone on a line. */}
      <div className={`grid gap-3 ${stats.length >= 4 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-1 sm:grid-cols-3"}`}>
        {stats.map((c) => {
          const swatch = String(rankScale(c.pctRank));
          return (
            <div key={c.crimeType} className="rounded-lg border border-border bg-card p-4">
              <div className="text-xs text-muted-foreground">
                {crimeLabel(c.crimeType)}
              </div>
              <div className="mt-1 font-mono text-lg tabular-nums text-foreground">
                {Math.round(c.ratePer100k).toLocaleString()}
                <span className="text-xs text-muted-foreground">/100k</span>
              </div>
              <div
                className="mt-1.5 inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium"
                style={{ backgroundColor: swatch, color: chipInk(swatch) }}
              >
                {ordinal(c.pctRank)} percentile
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {fyLabel(fy)}, 2-yr pooled. Recorded incidents: NSW Bureau of Crime Statistics
        and Research (BOCSAR); adjusted to the ABS Crime Victimisation Survey; ABS ERP
        population denominator. All CC BY 4.0. Percentile is the population-weighted
        rank <strong>among suburbs in the same state</strong> — higher means more
        reported crime. Ranks are never compared across states, because each police
        force counts offences under its own rules.
      </p>
    </section>
  );
}

function FederalRep({ s }: { s: Summary }) {
  if (!s.federalDivision && !s.stateDistrict) return null;
  const lean = s.federalTppAlp > 0
    ? (s.federalTppAlp >= 50 ? `Labor ${Math.round(s.federalTppAlp)}% 2PP` : `Coalition ${Math.round(100 - s.federalTppAlp)}% 2PP`)
    : "—";
  return (
    <section>
      <SectionHeading icon="representation">Representation</SectionHeading>
      <DlCard>
        <CultureRow label="Federal division" value={s.federalDivision || "—"} />
        <CultureRow label="Federal MP" value={s.federalMember ? `${titleCaseName(s.federalMember)}${s.federalPartyAb ? ` (${s.federalPartyAb})` : ""}` : "—"} />
        <CultureRow label="Two-party-preferred" value={lean} />
        <CultureRow label="State electorate" value={s.stateDistrict || "—"} />
        <CultureRow label="State MP" value={s.stateMember ? `${titleCaseName(s.stateMember)}${s.statePartyAb ? ` (${s.statePartyAb})` : ""}` : "—"} />
      </DlCard>
    </section>
  );
}

function AmenitiesGroup({ a, nbn }: { a: NonNullable<Summary["amenities"]>; nbn?: string }) {
  // Nothing meaningful (un-ingested / no amenities) → skip the section.
  if (!(a.schoolsTotal || a.supermarketsTotal || a.pubsBars || a.parksCount || a.librariesCount)) return null;
  const brands = [
    a.colesCount ? `${a.colesCount} Coles` : "",
    a.woolworthsCount ? `${a.woolworthsCount} Woolworths` : "",
    a.aldiCount ? `${a.aldiCount} Aldi` : "",
    a.igaCount ? `${a.igaCount} IGA` : "",
  ].filter(Boolean).join(" · ");
  // The amenity score itself is not a tile here: it is a composite OF these
  // counts, and listing it beside its own inputs reads as a peer measure. It is
  // reported once, ranked, in the band at the top.
  const tiles: Tile[] = [
    { label: "Schools", value: `${a.schoolsTotal}`, icon: "school" },
    { label: "Supermarkets", value: `${a.supermarketsTotal}`, icon: "supermarket" },
    { label: "Pubs & bars", value: `${a.pubsBars}`, icon: "pubs" },
    { label: "Parks", value: `${a.parksCount}`, icon: "parks" },
    { label: "Libraries", value: `${a.librariesCount}`, icon: "libraries" },
    { label: "GP clinics", value: `${a.gpCount}`, icon: "healthcare" },
    { label: "Pharmacies", value: `${a.pharmacyCount}`, icon: "pharmacy" },
    { label: "Hospitals", value: `${a.hospitalsCount}`, icon: "hospital" },
    { label: "Nearest supermarket", value: a.nearestSupermarketKm > 0 ? `${a.nearestSupermarketKm.toFixed(1)} km` : "—", icon: "supermarket" },
    { label: "Nearest train", value: a.nearestTrainKm > 0 ? `${a.nearestTrainKm.toFixed(1)} km` : "—", icon: "train" },
    { label: "Nearest hospital", value: a.nearestHospitalKm > 0 ? `${a.nearestHospitalKm.toFixed(1)} km` : "—", icon: "hospital" },
    { label: "Distance to coast", value: a.distToCoastKm > 0 ? (a.distToCoastKm < 20 ? `${a.distToCoastKm.toFixed(1)} km` : `${Math.round(a.distToCoastKm)} km`) : "On the coast", icon: "coast" },
    // NBN tiers are acronyms (FTTP, HFC) — never lowercased.
    ...(nbn ? [{ label: "NBN", value: nbn.toUpperCase(), icon: "nbn" } satisfies Tile] : []),
  ];
  return (
    <section>
      <SectionHeading icon="amenity-density">Local amenities</SectionHeading>
      <TileGrid tiles={tiles} />
      <p className="mt-2 text-[11px] text-muted-foreground">
        {brands ? <>Grocery mix: {brands}. </> : null}
        Amenity counts via{" "}
        {/* The link is the ODbL attribution requirement, not decoration. */}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          © OpenStreetMap contributors
        </a>{" "}
        (ODbL) &amp; Geoscience Australia HealthDirect (CC BY 4.0). Distance to coast derived from ABS state boundaries (CC BY 4.0).
      </p>
    </section>
  );
}

function SchoolSectorCard({ a }: { a: NonNullable<Summary["amenities"]> }) {
  const total = a.schoolsGov + a.schoolsCatholic + a.schoolsIndependent;
  // Coverage signal: a suburb with no ACARA school inside it scans to 0 across
  // the board; require some sector data (or a nearest-secondary) before
  // rendering. ACARA covers every state (prod 2026-09-24: sector counts on
  // 4,940 suburbs, nearest-secondary on 15,320).
  if (total <= 0 && !(a.nearestSecondaryKm > 0)) return null;
  return (
    <section>
      <SectionHeading icon="school">Schools by sector</SectionHeading>
      <DlCard footnote="School sector & type: ACARA (Australian Curriculum, Assessment and Reporting Authority), School Location dataset.">
        {/* A suburb with no school inside it reads 0 / 0 / 0. A row of zeros
            reads as a claim, so the counts show only when there is at least one
            school; the nearest-secondary distance still renders without them. */}
        {total > 0 ? (
          <>
            <CultureRow label="Government / Catholic / Indep." value={`${a.schoolsGov} / ${a.schoolsCatholic} / ${a.schoolsIndependent}`} />
            <CultureRow label="Primary / Secondary" value={`${a.schoolsPrimary} / ${a.schoolsSecondary}`} />
          </>
        ) : null}
        <CultureRow label="Nearest secondary" value={a.nearestSecondaryKm > 0 ? `${a.nearestSecondaryKm.toFixed(1)} km` : "—"} />
      </DlCard>
    </section>
  );
}

function CultureCard({ d }: { d: Demographics }) {
  const pct = (v?: number) => (v && v > 0 ? `${Math.round(v)}%` : "—");
  const religion = d.topReligion
    ? `${d.topReligion}${d.pctTopReligion ? ` · ${Math.round(d.pctTopReligion)}%` : ""}`
    : "—";
  const language = d.topLanguage
    ? `${d.topLanguage}${d.pctTopLanguage ? ` · ${Math.round(d.pctTopLanguage)}%` : ""}`
    : "English only";
  // Nothing cultural to show (suppressed small suburb) → skip the section.
  if (!d.topReligion && !d.topLanguage && !(d.pctBornOverseas > 0)) return null;
  return (
    <section>
      <SectionHeading icon="culture">Culture &amp; community</SectionHeading>
      <DlCard>
        <CultureRow label="Dominant religion" value={religion} />
        <CultureRow label="Top language at home" value={language} />
        <CultureRow label="No religion" value={pct(d.pctNoReligion)} />
        <CultureRow label="Born overseas" value={pct(d.pctBornOverseas)} />
        <CultureRow label="English only at home" value={pct(d.pctEnglishOnly)} />
      </DlCard>
    </section>
  );
}

/** A card of label/value rows, with the licence line the dataset requires. */
function DlCard({ children, footnote }: { children: ReactNode; footnote?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <dl className="grid grid-cols-1 gap-y-2 text-xs">{children}</dl>
      {footnote ? (
        <p className="mt-2.5 text-[11px] text-muted-foreground [text-wrap:pretty]">{footnote}</p>
      ) : null}
    </div>
  );
}

function CultureRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="truncate text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

type Tile = {
  label: string;
  value: string;
  icon: HousingIconName;
  delta?: { text: string; positive: boolean };
};

/**
 * Hairline-separated stat grid: one border colour showing through 1px gaps, so a
 * dozen metrics read as one table instead of a dozen floating cards.
 *
 * The icon sits ABOVE the label below `sm`. Three padding layers (container,
 * page, tile) plus a 22px inline icon left roughly 52px for the value at 320px,
 * which mono currency overflows; stacking reclaims it.
 */
function TileGrid({ tiles, cols = "sm:grid-cols-3 lg:grid-cols-4" }: { tiles: Tile[]; cols?: string }) {
  // A tile with no value is a hole in the grid, not information — several Census
  // and Local-Insights columns are NULL for whole states. Drop them rather than
  // paving the page with em-dashes.
  const shown = tiles.filter((t) => t.value !== "—");
  if (!shown.length) return null;
  return (
    // Hairlines are drawn by the CELLS, not by a border-coloured container
    // showing through gaps. With the gap technique, a last row that does not
    // divide evenly into the column count leaves a slab of raw border colour —
    // and the column count changes at every breakpoint, so no fixed number of
    // filler cells can cover it. Cell borders plus a clipped -1px offset give
    // the same hairline at every width and leave short rows blank.
    <div className={`overflow-hidden rounded-xl border border-border bg-card`}>
      <div className={`-mb-px -mr-px grid grid-cols-2 ${cols}`}>
      {shown.map((t) => (
        <div key={t.label} className="flex flex-col gap-1 border-b border-r border-border px-3 py-3 sm:flex-row sm:items-start sm:gap-2.5 sm:px-3.5">
          <HousingIcon name={t.icon} size={22} className="shrink-0 sm:mt-0.5" />
          <div className="min-w-0">
            <div className="text-[11px] leading-tight text-muted-foreground">{t.label}</div>
            <div className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums text-foreground">{t.value}</div>
            {t.delta ? (
              <div
                className="mt-0.5 font-mono text-[10px] tabular-nums"
                style={{ color: t.delta.positive ? "var(--semantic-green-text)" : "var(--semantic-red-text)" }}
              >
                {t.delta.text}
              </div>
            ) : null}
          </div>
        </div>
      ))}
      </div>
    </div>
  );
}

/** Top-level sections of the main column are h2s — the sidebar's widget headings
 * are the h3s. The reverse made a six-link sidebar list outrank the page's own
 * content in a screen reader's heading rotor. */
function SectionHeading({ icon, children }: { icon: HousingIconName; children: ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2.5 font-serif text-2xl text-foreground">
      <HousingIcon name={icon} size={26} /> {children}
    </h2>
  );
}

/** Shared filled track for comparison metrics and fixed 1–10 decile scales. */
function FilledMetricTrack({
  fillPercent,
  children,
}: {
  fillPercent: number;
  children?: ReactNode;
}) {
  const width = `${Math.min(100, Math.max(0, fillPercent))}%`;
  return (
    <div className="relative mt-4 h-3.5 rounded bg-muted">
      <div className="absolute inset-y-0 left-0 rounded bg-primary" style={{ width }} />
      {children}
    </div>
  );
}

/**
 * One metric as a single filled bar with tick marks where the state and national
 * baselines fall — so "how much more is this than average" is a distance you can
 * see, rather than three bars you have to mentally subtract.
 *
 * The ticks are the whole idea, so they are full-strength and labelled: an
 * earlier pass distinguished them only by opacity (55% and 30% of foreground),
 * which put the national mark at 1.71:1 on the track and left no way to tell
 * which mark was which.
 */
type CompareRef = {
  /** Short label on the tick above the bar. */
  tick: string;
  /** Full label in the figures line and the delta text. */
  label: string;
  value: number;
  href?: string;
  dashed?: boolean;
};

const quarterLabel = (isoDate: string) => {
  const [y, m] = isoDate.split("-").map(Number);
  return y && m ? `${["Mar", "Jun", "Sep", "Dec"][Math.floor((m - 1) / 3)]} ${y}` : isoDate;
};

/**
 * The suburb's figure as a filled bar, with each reference as a tick. The
 * references are named in full under the bar, and every one is labelled by what
 * it is (an ABS region, the median suburb) rather than a bare state code.
 */
function CompareBar({
  label, name, suburb, refs, fmt, showDeltas = false,
}: {
  label: string; name: string; suburb: number; refs: CompareRef[]; fmt: (v: number) => string; showDeltas?: boolean;
}) {
  if (suburb <= 0) return null;
  const shown = refs.filter((r) => r.value > 0);
  const max = Math.max(suburb, ...shown.map((r) => r.value)) * 1.02;
  const share = (v: number) => Math.min(100, Math.max(0, (v / max) * 100));
  const pctOf = (v: number) => `${share(v)}%`;
  const deltas = showDeltas
    ? shown.map((r) => ({ label: r.label, pct: Math.round((suburb / r.value - 1) * 100) }))
    : [];
  // Two references that close overlap into an unreadable smudge; below the
  // collision threshold they share one tick and one label.
  const collide = shown.length === 2 && Math.abs(share(shown[0]!.value) - share(shown[1]!.value)) < 9;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-xs text-foreground">{label}</span>
        <span className="text-right text-[11px] text-muted-foreground">
          {deltas.map((dl, i) => (
            <span key={dl.label}>
              {i > 0 ? " · " : null}
              <span className="font-semibold text-primary">{dl.pct >= 0 ? "+" : ""}{dl.pct}%</span> vs {dl.label}
            </span>
          ))}
        </span>
      </div>
      <FilledMetricTrack fillPercent={share(suburb)}>
        {collide ? (
          <Baseline label={`${shown[0]!.tick} · ${shown[1]!.tick}`} left={pctOf((shown[0]!.value + shown[1]!.value) / 2)} dashed={false} />
        ) : (
          shown.map((r) => <Baseline key={r.label} label={r.tick} left={pctOf(r.value)} dashed={Boolean(r.dashed)} />)
        )}
      </FilledMetricTrack>
      <div className="mt-1 flex justify-between gap-3 font-mono text-[10px] tabular-nums text-muted-foreground">
        <span>
          {shown.map((r, i) => (
            <span key={r.label}>
              {i > 0 ? " · " : null}
              {r.href ? (
                <Link href={r.href} className="hit-target underline-offset-2 hover:text-foreground hover:underline">{r.label} {fmt(r.value)}</Link>
              ) : `${r.label} ${fmt(r.value)}`}
            </span>
          ))}
        </span>
        <span className="truncate font-semibold text-foreground">
          {name} {fmt(suburb)}
        </span>
      </div>
    </div>
  );
}

/** A labelled reference mark. CompareBar uses solid for state and dashed for
 * national; the SEIFA scale uses a dashed midpoint. */
function Baseline({ label, left, dashed }: { label: string; left: string; dashed: boolean }) {
  return (
    <span className="absolute -top-4 bottom-0 flex flex-col items-center" style={{ left }}>
      <span className="font-mono text-[9px] leading-none text-muted-foreground">{label}</span>
      <span
        className={`mt-0.5 w-px flex-1 ${dashed ? "border-l border-dashed border-foreground" : "bg-foreground"}`}
      />
    </span>
  );
}

/**
 * The closing provenance line, built from what the page ACTUALLY rendered.
 *
 * It used to name ABS, the Valuer-General, ACARA, OpenStreetMap and the AEC
 * unconditionally and collapse their terms into "CC BY 4.0 / ODbL". That is
 * false on most of the corpus — QLD, WA, ACT, TAS and NT have no Valuer-General
 * feed at all, and ACARA sector data is scoped to VIC and QLD — and a licence
 * notice that credits sources a page did not use is not attribution, it is
 * noise. Each entry now appears only when its section did, carries its own
 * terms, and links where the licence requires a link.
 *
 * Exported for suburb-profile-sources.test.tsx — attribution is a licence
 * obligation, so it gets a regression guard rather than trust.
 */
// Attribution strings keyed by SuburbHazardExposure source ids. Each is a
// licence obligation of the dataset it names; an id absent here credits nothing
// rather than something wrong.
const STATUTORY_HAZARD_CREDITS: Record<string, { credit: string; licence: string }> = {
  nsw_epi_flood: { credit: "NSW Environmental Planning Instrument — Flood, NSW Department of Planning", licence: "CC BY 4.0" },
  vic_plan_overlay_lsio_fo_sbo: { credit: "Vicmap Planning overlays, Department of Transport and Planning Victoria", licence: "CC BY 4.0" },
  sa_pdcode_hazards_flooding: { credit: "Planning and Design Code overlays (Hazards — Flooding, and Flooding — General), Government of South Australia", licence: "CC BY 3.0 AU" },
  tas_tps_flood_prone: { credit: "Tasmanian Planning Scheme — Code Overlay (Flood-prone Areas), Tasmanian Planning Commission via theLIST", licence: "CC BY 3.0 AU" },
  act_flood_extent_1pct_aep: { credit: "ACT Flood Extent Model (1% AEP), ACT Government", licence: "CC BY 4.0" },
  nsw_bfpl: { credit: "NSW Bush Fire Prone Land, NSW Rural Fire Service", licence: "CC BY 4.0" },
  vic_bpa: { credit: "Designated Bushfire Prone Area, Department of Transport and Planning Victoria", licence: "CC BY 4.0" },
  qld_qfd_bpa: { credit: "Bushfire Prone Area — Queensland series, Queensland Fire Department", licence: "CC BY 4.0" },
  sa_pdcode_hazards_bushfire: { credit: "Planning and Design Code overlays (Hazards — Bushfire), Government of South Australia", licence: "CC BY 3.0 AU" },
  wa_obrm_026_bpa: { credit: "Bush Fire Prone Areas (OBRM-026), Office of Bushfire Risk Management WA", licence: "CC BY 4.0" },
  tas_tps_bushfire_prone: { credit: "Tasmanian Planning Scheme — Code Overlay (Bushfire-prone Areas), Tasmanian Planning Commission via theLIST", licence: "CC BY 3.0 AU" },
  act_bpa_2026: { credit: "Bushfire Prone Area 2026, ACT Government", licence: "CC BY 4.0" },
  // Retired id (VIC bushfire before the switch to the BPA). Rows loaded earlier
  // carry it until the next -mode hazards load, and attribution must not lapse
  // in between, so the web can deploy before the data.
  vic_plan_overlay_bmo: { credit: "Vicmap Planning Bushfire Management Overlay, Department of Transport and Planning Victoria", licence: "CC BY 4.0" },
};

export function SourcesLine({
  censusYear, hasCensus, hasPrice, hasAmenities, hasSchoolSectors,
  hasFederal, hasStateMember, hasTerrain = false, hasWaterObservations = false,
  statutoryHazardSources = [], planningSources = [], stateName,
}: {
  censusYear?: number;
  hasCensus: boolean;
  hasPrice: boolean;
  hasAmenities: boolean;
  hasSchoolSectors: boolean;
  hasFederal: boolean;
  hasStateMember: boolean;
  /** GA DEM-S elevation rendered on the page. */
  hasTerrain?: boolean;
  /** DEA Water Observations share rendered on the page. */
  hasWaterObservations?: boolean;
  /** Source ids from SuburbHazardExposure (flood_source / bushfire_source): a share or a "Not mapped" tile read off that layer. */
  statutoryHazardSources?: string[];
  /** Planning source ids the planning card rendered (planningCreditIds). */
  planningSources?: string[];
  stateName: string;
}) {
  const parts: ReactNode[] = [];
  // Always true: the locator map and the suburb itself are ASGS geography.
  parts.push(<>ABS ASGS boundaries (CC BY 4.0)</>);
  if (hasCensus) {
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing -- proto int32 defaults to 0, which must fall through to the corpus year
    parts.push(<>ABS Census {censusYear || 2021} (CC BY 4.0)</>);
  }
  if (hasPrice) parts.push(<>{stateName} Valuer-General settled transfers (CC BY 4.0)</>);
  if (hasSchoolSectors) parts.push(<>ACARA School Locations (CC BY 4.0)</>);
  if (hasAmenities) {
    parts.push(
      <>
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          © OpenStreetMap contributors
        </a>{" "}
        (ODbL)
      </>,
    );
  }
  if (hasFederal) parts.push(<>Australian Electoral Commission (CC BY 4.0)</>);
  if (hasTerrain) parts.push(<>Geoscience Australia 1 Second DEM-S (CC BY 4.0)</>);
  if (hasWaterObservations) parts.push(<>DEA Water Observations Statistics, Geoscience Australia (CC BY 4.0)</>);
  for (const id of new Set(statutoryHazardSources)) {
    const entry = STATUTORY_HAZARD_CREDITS[id];
    if (entry) parts.push(<>{entry.credit} ({entry.licence})</>);
  }
  for (const id of new Set(planningSources)) {
    const source = PLANNING_SOURCE_CREDITS[id];
    if (source) parts.push(<>{source.credit} ({source.licence})</>);
  }
  if (hasStateMember) {
    parts.push(
      <>
        <a
          href="https://en.wikipedia.org/wiki/Wikipedia:Text_of_the_Creative_Commons_Attribution-ShareAlike_4.0_International_License"
          target="_blank"
          rel="noopener noreferrer"
          className="underline underline-offset-2 hover:text-foreground"
        >
          Wikipedia
        </a>{" "}
        state-member tables (CC BY-SA 4.0)
      </>,
    );
  }

  return (
    <p className="text-[11px] text-muted-foreground [text-wrap:pretty]">
      Sources:{" "}
      {parts.map((part, i) => (
        <span key={i}>
          {i > 0 ? "; " : null}
          {part}
        </span>
      ))}
      . Not financial advice.
    </p>
  );
}
