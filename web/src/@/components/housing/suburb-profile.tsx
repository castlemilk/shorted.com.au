// NO "use client" — this is the server-rendered body of /housing/[state]/[suburb].
//
// It used to be a client component behind dynamic({ssr:false}), which meant every
// one of the ~3,600 suburb URLs advertised in the sitemap served a 520px grey
// skeleton: no <h1>, no price, no demographics in the HTML. The profile was
// already fetched on the server and then thrown at the client to re-render.
//
// So the rule here is: anything that can be computed from the profile the server
// already holds is rendered on the server. Only three things stay client-side,
// each as its own island, and each for a stated reason:
//   - HousingSeriesChart / SuburbLocatorMap — pull connect-web in, which breaks
//     SSR (see CLAUDE.md), so they load via dynamic({ssr:false}) wrappers.
//   - SuburbNearbyRail — needs a large state-wide fetch, deliberately deferred
//     to idle so it never competes with this page's own content.
//   - RecentPriceDrops — crawl-derived and kill-switchable, so it must re-read
//     at request time rather than bake into a 24h ISR page.
//
// Keep it that way: adding a hook or a client-action import to this file silently
// drags the whole body back out of the HTML.
import { type ReactNode } from "react";
import { SuburbPoliticianPropertyCard } from "@/components/politicians/suburb-politician-property-card-loader";
import Link from "next/link";
import type {
  GetSuburbProfileResponse,
  LgaInfo,
  SuburbCrime,
  SuburbDemographics,
  SuburbSummary,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { HousingSeriesChart } from "./housing-charts";
import { SuburbBanner } from "./suburb-banner";
import { SuburbLocatorMap } from "./suburb-locator-map-loader";
import { SuburbNearbyRail } from "./suburb-nearby-rail-loader";
import { RecentPriceDrops } from "./suburb-recent-price-drops-loader";
import { STATE_NAMES, stateSlug, suburbHref } from "@/lib/housing/states";
import { crimeRankScale } from "@/lib/housing/highlight-metrics";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { HousingIcon, type HousingIconName } from "./housing-icon";

const fmtAUD = (v: number) =>
  v >= 1_000_000 ? `$${(v / 1_000_000).toFixed(2)}M` : v >= 1_000 ? `$${Math.round(v / 1000)}k` : `$${Math.round(v)}`;
const fmtMoney = (v: number) => `$${Math.round(v).toLocaleString()}`;
const fmtSignedPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;

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
};

export function SuburbProfile({
  salCode, regionCode, stateCode, profile,
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
  const chartRegion = s.regionCode || regionCode;
  const priced = s.latestMedianPrice > 0;
  const asOf = fmtPeriod(s.latestPeriod?.seconds);
  const stateName = STATE_NAMES[st] ?? s.stateCode;

  const pctVs = (base?: number) => (priced && base && base > 0)
    ? Math.round((s.latestMedianPrice / base - 1) * 100) : null;

  return (
    <div className="space-y-6">
      {/* back affordance */}
      {st ? (
        <Link href={`/housing/${stateSlug(st)}`} className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground">
          ‹ Back to {stateName} map
        </Link>
      ) : null}

      {/* header */}
      <SuburbBanner
        name={s.salName}
        sub={`${stateName}${s.postcode ? ` · ${s.postcode}` : ""}${d?.censusYear ? ` · Census ${d.censusYear}` : ""}`}
        stat={priced ? fmtAUD(s.latestMedianPrice) : undefined}
        statSub={priced
          ? `${s.yoyPct === 0 ? "flat yr" : `${s.yoyPct >= 0 ? "+" : ""}${s.yoyPct.toFixed(1)}% yr`} · median house${asOf ? ` · ${asOf}` : ""}`
          : "Price not tracked"}
        banner={data.banner ? {
          archetype: data.banner.archetype,
          blurb: data.banner.blurb,
          bgKey: data.banner.bgKey,
          bgUrl: data.banner.bgUrl || undefined,
        } : undefined}
        stateCode={st}
        salCode={s.salCode}
      />
      {priced ? (
        <Link
          href={`/housing/calculators?price=${Math.round(s.latestMedianPrice)}${st ? `&state=${st}` : ""}`}
          className="inline-block text-xs text-primary transition-colors hover:text-foreground"
        >
          Estimate repayments for this suburb →
        </Link>
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        {/* main column */}
        <div className="space-y-6">
          {/* price chart or empty-state */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 flex items-center gap-2 font-serif text-lg text-foreground">
              <HousingIcon name="median-price" size={24} /> Median house price
            </h2>
            {chartRegion ? (
              <HousingSeriesChart regionCode={chartRegion} measure="median_price" dwellingType="house" ariaLabel={`${s.salName} median house price`} format="aud" height={280} />
            ) : (
              <div className="flex h-[160px] flex-col items-center justify-center gap-1 text-center text-sm text-muted-foreground">
                <p>No median price series for {s.salName} yet.</p>
                <p className="text-xs">Valuer-General pricing is unavailable for this suburb.{b?.stateMedianPrice ? ` ${stateName} suburb median: ${fmtPriceShort(b.stateMedianPrice)}.` : ""}</p>
              </div>
            )}
          </div>

          {/* demographics — grouped */}
          <div className="space-y-4">
            <DemoGroup title="People" icon="population" stats={[
              ["Population", d?.population ? d.population.toLocaleString() : "—", "population"],
              ["Median age", d?.medianAge ? `${d.medianAge} yrs` : "—", "age"],
              ["Income / person / wk", d?.medianWeeklyPerIncome ? fmtMoney(d.medianWeeklyPerIncome) : "—", "income"],
              ["Household income / wk", d?.medianWeeklyHhdIncome ? fmtMoney(d.medianWeeklyHhdIncome) : "—", "income"],
            ]} />
            <DemoGroup title="Housing" icon="dwellings" stats={[
              ["Median rent / wk", d?.medianWeeklyRent ? fmtMoney(d.medianWeeklyRent) : "—", "rent"],
              ["Mortgage / month", d?.medianMonthlyMortgage ? fmtMoney(d.medianMonthlyMortgage) : "—", "mortgage"],
            ]} />
            {d ? <CultureStats d={d} /> : null}
            {s.amenities ? <AmenitiesGroup a={s.amenities} nbn={s.dominantNbnTech} /> : null}
            {s.amenities ? <SchoolSectorCard a={s.amenities} /> : null}
            {data.council?.lgaName ? <CouncilCard c={data.council} /> : null}
            <FederalRep s={s} />
            <SuburbPoliticianPropertyCard salCode={salCode} />
            <CrimeCard crime={data.crime} />
          </div>

          {/* comparison */}
          <div className="rounded-xl border border-border bg-card p-5">
            <h2 className="mb-3 flex items-center gap-2 font-serif text-lg text-foreground">
              <HousingIcon name="compare" size={24} /> How it compares
            </h2>
            {priced ? (
              <CompareBar
                label="Median house price" suburb={s.latestMedianPrice}
                state={b?.stateMedianPrice ?? 0} nation={b?.nationalMedianPrice ?? 0}
                stateHref={st ? `/housing/${stateSlug(st)}` : undefined} nationHref="/housing"
                fmt={fmtAUD} deltaNation={pctVs(b?.nationalMedianPrice)}
              />
            ) : null}
            <CompareBar
              label="Household income / wk" suburb={d?.medianWeeklyHhdIncome ?? 0}
              state={b?.stateMedianWeeklyHhdIncome ?? 0} nation={b?.nationalMedianWeeklyHhdIncome ?? 0}
              stateHref={st ? `/housing/${stateSlug(st)}` : undefined} nationHref="/housing" fmt={fmtMoney}
            />
          </div>
        </div>

        {/* right rail */}
        <div className="space-y-6">
          {st ? <SuburbLocatorMap stateCode={st} salCode={s.salCode} salName={s.salName} /> : null}

          {st ? (
            <SuburbNearbyRail
              stateCode={st}
              salCode={s.salCode}
              postcode={s.postcode}
              latestMedianPrice={s.latestMedianPrice}
            />
          ) : null}

          {data.similar?.length ? (
            <div className="rounded-xl border border-border bg-card p-4">
              <h2 className="mb-1 flex items-center gap-1.5 font-serif text-base text-foreground">
                <HousingIcon name="similar" size={22} /> Similar suburbs
              </h2>
              <p className="mb-2 text-[11px] text-muted-foreground">Closest demographic &amp; amenity profile, nationally.</p>
              <div className="flex flex-col">
                {data.similar.map((n) => (
                  <Link key={n.salCode} href={suburbHref(n.stateCode, { salName: n.salName, salCode: n.salCode, postcode: "" })}
                    className="flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground">
                    <span className="truncate capitalize">
                      {n.salName.toLowerCase()} <span className="text-[10px] uppercase opacity-60">{n.stateCode}</span>
                    </span>
                    <span className="shrink-0 font-mono text-[11px] tabular-nums">
                      {n.latestMedianPrice > 0 ? fmtPriceShort(n.latestMedianPrice) : `${Math.round(n.similarity * 100)}% match`}
                    </span>
                  </Link>
                ))}
              </div>
            </div>
          ) : null}

          <RecentPriceDrops salCode={s.salCode} regionCode={chartRegion} />
        </div>
      </div>
    </div>
  );
}

type Demographics = SuburbDemographics;

type Summary = SuburbSummary;
type Crime = SuburbCrime;

const CRIME_LABELS: Record<string, string> = {
  break_ins: "Break-ins",
  violent: "Violent crime",
  motor_vehicle: "Car theft",
};
const fyLabel = (fy: number) => `FY${fy - 1}–${String(fy).slice(2)}`;
const ordinal = (n: number) => {
  const v = Math.round(n), r = v % 10, t = v % 100;
  return `${v}${t >= 11 && t <= 13 ? "th" : r === 1 ? "st" : r === 2 ? "nd" : r === 3 ? "rd" : "th"}`;
};

/** Crime & safety — latest 2-yr-pooled, CVS-adjusted stats. Renders nothing
 * when the suburb has no reliable data (uncovered state, TAS/NT, or a
 * small-population/unreliable suburb gated server-side) — never zeros. */
export function CrimeCard({ crime }: { crime: Crime | undefined }) {
  const stats = crime?.stats ?? [];
  if (stats.length === 0) return null;
  const fy = stats[0]!.fyEnding;
  const rankScale = crimeRankScale();
  return (
    <div>
      <SectionHeading icon="dwellings">Crime &amp; safety</SectionHeading>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {stats.map((c) => (
          <div key={c.crimeType} className="rounded-lg border border-border bg-card p-4">
            <div className="text-xs text-muted-foreground">
              {CRIME_LABELS[c.crimeType] ?? c.crimeType.replace(/_/g, " ")}
            </div>
            <div className="mt-1 font-mono text-lg tabular-nums text-foreground">
              {Math.round(c.ratePer100k).toLocaleString()}
              <span className="text-xs text-muted-foreground">/100k</span>
            </div>
            <div
              className={`mt-1.5 inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-[11px] font-medium ${c.pctRank > 65 ? "text-white" : "text-black"}`}
              style={{ backgroundColor: rankScale(c.pctRank) }}
            >
              {ordinal(c.pctRank)} percentile
            </div>
          </div>
        ))}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground opacity-70">
        {fyLabel(fy)}, 2-yr pooled. Recorded incidents: NSW Bureau of Crime Statistics
        and Research (BOCSAR); adjusted to the ABS Crime Victimisation Survey; ABS ERP
        population denominator. All CC BY 4.0. Percentile is the population-weighted
        rank <strong>among suburbs in the same state</strong> — higher means more
        reported crime. Ranks are never compared across states, because each police
        force counts offences under its own rules.
      </p>
    </div>
  );
}

const fmtMemberName = (n: string) => n.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase());

function FederalRep({ s }: { s: Summary }) {
  if (!s.federalDivision && !s.stateDistrict) return null;
  const lean = s.federalTppAlp > 0
    ? (s.federalTppAlp >= 50 ? `Labor ${Math.round(s.federalTppAlp)}% 2PP` : `Coalition ${Math.round(100 - s.federalTppAlp)}% 2PP`)
    : "—";
  return (
    <div>
      <SectionHeading icon="representation">Representation</SectionHeading>
      <div className="rounded-lg border border-border bg-card p-4">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 text-sm sm:grid-cols-2">
          <CultureRow label="Federal division" value={s.federalDivision || "—"} />
          <CultureRow label="Federal MP" value={s.federalMember ? `${fmtMemberName(s.federalMember)}${s.federalPartyAb ? ` (${s.federalPartyAb})` : ""}` : "—"} />
          <CultureRow label="Two-party-preferred" value={lean} />
          <CultureRow label="State electorate" value={s.stateDistrict || "—"} />
          <CultureRow label="State MP" value={s.stateMember ? `${fmtMemberName(s.stateMember)}${s.statePartyAb ? ` (${s.statePartyAb})` : ""}` : "—"} />
        </dl>
      </div>
    </div>
  );
}

type Council = LgaInfo;
function CouncilCard({ c }: { c: Council }) {
  if (!c.lgaName) return null;
  return (
    <div>
      <SectionHeading icon="council">Local council</SectionHeading>
      <div className="rounded-lg border border-border bg-card p-4">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 text-sm sm:grid-cols-2">
          <CultureRow label="Council (LGA)" value={c.lgaName} />
          <CultureRow label="Council population" value={c.population > 0 ? c.population.toLocaleString() : "—"} />
          <CultureRow label="Council area" value={c.areaSqkm > 0 ? `${Math.round(c.areaSqkm).toLocaleString()} km²` : "—"} />
          <CultureRow label="Density" value={c.population > 0 && c.areaSqkm > 0 ? `${Math.round(c.population / c.areaSqkm).toLocaleString()}/km²` : "—"} />
          <CultureRow label="Federal grants" value={c.fedFagAud > 0 ? `${fmtAUD(c.fedFagAud)}/yr${c.fedFagYear ? ` (${c.fedFagYear})` : ""}` : "—"} />
          <CultureRow label="Grants per resident" value={c.fedFagAud > 0 && c.population > 0 ? `$${Math.round(c.fedFagAud / c.population).toLocaleString()}/yr` : "—"} />
          {c.avgRates > 0 ? (
            <>
              <CultureRow label="Avg rates / property" value={fmtMoney(c.avgRates)} />
              <CultureRow label="Operating result" value={fmtSignedPct(c.opSurplusRatio)} />
              <CultureRow label="Asset renewal" value={`${Math.round(c.assetRenewalRatio)}%`} />
            </>
          ) : null}
        </dl>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground opacity-70">
        Council boundary: ABS ASGS LGA 2024. Federal grants: Financial Assistance Grants, Dept of Infrastructure.
        {c.finSource === "vic_lgprf" ? ` Financials: VIC Local Government Performance Reporting${c.finYear ? ` ${c.finYear}` : ""}, Local Government Victoria.` : ""} All CC BY 4.0.
      </p>
    </div>
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
  const stats: IconStat[] = [
    ["Amenity score", a.amenityDensityScore > 0 ? `${Math.round(a.amenityDensityScore)}/100` : "—", "amenity-density"],
    ["Schools", `${a.schoolsTotal}`, "school"],
    ["Supermarkets", `${a.supermarketsTotal}`, "supermarket"],
    ["Pubs & bars", `${a.pubsBars}`, "pubs"],
    ["Parks", `${a.parksCount}`, "parks"],
    ["Libraries", `${a.librariesCount}`, "libraries"],
    ["GP clinics", `${a.gpCount}`, "healthcare"],
    ["Pharmacies", `${a.pharmacyCount}`, "pharmacy"],
    ["Hospitals", `${a.hospitalsCount}`, "hospital"],
    ["Nearest supermarket", a.nearestSupermarketKm > 0 ? `${a.nearestSupermarketKm.toFixed(1)} km` : "—", "supermarket"],
    ["Nearest train", a.nearestTrainKm > 0 ? `${a.nearestTrainKm.toFixed(1)} km` : "—", "train"],
    ["Nearest hospital", a.nearestHospitalKm > 0 ? `${a.nearestHospitalKm.toFixed(1)} km` : "—", "hospital"],
    ["Distance to coast", a.distToCoastKm > 0 ? (a.distToCoastKm < 20 ? `${a.distToCoastKm.toFixed(1)} km` : `${Math.round(a.distToCoastKm)} km`) : "On the coast", "coast"],
    ...(nbn ? [["NBN", nbn, "nbn"] as IconStat] : []),
  ];
  return (
    <div>
      <SectionHeading icon="amenity-density">Local amenities</SectionHeading>
      <StatGrid stats={stats} />
      <p className="mt-2 text-[11px] text-muted-foreground">
        {brands ? <>Grocery mix: {brands}. </> : null}
        <span className="opacity-70">Amenity counts via © OpenStreetMap contributors (ODbL) &amp; Geoscience Australia HealthDirect (CC BY 4.0). Distance to coast derived from ABS state boundaries (CC BY 4.0).</span>
      </p>
    </div>
  );
}

function SchoolSectorCard({ a }: { a: NonNullable<Summary["amenities"]> }) {
  const total = a.schoolsGov + a.schoolsCatholic + a.schoolsIndependent;
  // Coverage signal: uncovered states scan to 0 across the board; require some
  // sector data (or a nearest-secondary) before rendering. Scoped to VIC & QLD.
  if (total <= 0 && !(a.nearestSecondaryKm > 0)) return null;
  const stats: IconStat[] = [
    ["Government", `${a.schoolsGov}`, "school"],
    ["Catholic", `${a.schoolsCatholic}`, "religion"],
    ["Independent", `${a.schoolsIndependent}`, "school"],
    ["Primary", `${a.schoolsPrimary}`, "age"],
    ["Secondary", `${a.schoolsSecondary}`, "school"],
    ["Nearest secondary", a.nearestSecondaryKm > 0 ? `${a.nearestSecondaryKm.toFixed(1)} km` : "—", "location"],
  ];
  return (
    <div>
      <SectionHeading icon="school">Schools by sector</SectionHeading>
      <StatGrid stats={stats} cols="grid-cols-3 sm:grid-cols-6" />
      <p className="mt-2 text-[11px] text-muted-foreground opacity-70">
        School sector &amp; type: ACARA (Australian Curriculum, Assessment and Reporting Authority), School Location dataset.
      </p>
    </div>
  );
}

function CultureStats({ d }: { d: Demographics }) {
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
    <div>
      <SectionHeading icon="culture">Culture &amp; community</SectionHeading>
      <div className="rounded-lg border border-border bg-card p-4">
        <dl className="grid grid-cols-1 gap-x-8 gap-y-2.5 text-sm sm:grid-cols-2">
          <CultureRow label="Dominant religion" value={religion} />
          <CultureRow label="Top language at home" value={language} />
          <CultureRow label="No religion" value={pct(d.pctNoReligion)} />
          <CultureRow label="Born overseas" value={pct(d.pctBornOverseas)} />
          <CultureRow label="English only at home" value={pct(d.pctEnglishOnly)} />
        </dl>
      </div>
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

// Icon-led stat tile: the detail's custom warm-duotone icon sits above its
// label + value, so every suburb metric reads by its icon first.
function StatTile({ icon, label, value }: { icon: HousingIconName; label: string; value: string }) {
  return (
    <div className="flex flex-col items-center rounded-lg border border-border bg-card p-4 text-center">
      <HousingIcon name={icon} size={30} className="mb-2" />
      <div className="text-xs leading-tight text-muted-foreground">{label}</div>
      <div className="mt-0.5 font-mono text-lg tabular-nums text-foreground">{value}</div>
    </div>
  );
}

type IconStat = [label: string, value: string, icon: HousingIconName];

function StatGrid({ stats, cols = "grid-cols-2 sm:grid-cols-4" }: { stats: IconStat[]; cols?: string }) {
  return (
    <div className={`grid gap-3 ${cols}`}>
      {stats.map(([label, value, icon]) => (
        <StatTile key={label} icon={icon} label={label} value={value} />
      ))}
    </div>
  );
}

function SectionHeading({ icon, children }: { icon: HousingIconName; children: ReactNode }) {
  return (
    <h3 className="mb-2.5 flex items-center gap-2 font-serif text-base text-foreground">
      <HousingIcon name={icon} size={26} /> {children}
    </h3>
  );
}

function DemoGroup({ title, icon, stats }: { title: string; icon: HousingIconName; stats: IconStat[] }) {
  return (
    <div>
      <SectionHeading icon={icon}>{title}</SectionHeading>
      <StatGrid stats={stats} />
    </div>
  );
}

function CompareBar({
  label, suburb, state, nation, fmt, stateHref, nationHref, deltaNation,
}: {
  label: string; suburb: number; state: number; nation: number; fmt: (v: number) => string;
  stateHref?: string; nationHref?: string; deltaNation?: number | null;
}) {
  const max = Math.max(suburb, state, nation, 1);
  const Row = ({ name, v, cls, href }: { name: string; v: number; cls: string; href?: string }) => (
    <div className="flex items-center gap-2 py-1 text-xs">
      <span className="w-14 shrink-0">
        {href ? <Link href={href} className="text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{name}</Link> : <span className="text-muted-foreground">{name}</span>}
      </span>
      <div className="h-3 flex-1 rounded bg-muted">
        <div className={cls} style={{ width: `${(v / max) * 100}%`, height: "100%", borderRadius: 4 }} />
      </div>
      <span className="w-20 shrink-0 whitespace-nowrap text-right font-mono tabular-nums">{v > 0 ? fmt(v) : "—"}</span>
    </div>
  );
  return (
    <div className="mb-4 last:mb-0">
      <div className="mb-1 flex items-center justify-between">
        <span className="text-sm text-foreground">{label}</span>
        {typeof deltaNation === "number" ? (
          <span className={deltaNation >= 0 ? "text-[10px] text-[color:var(--semantic-green)]" : "text-[10px] text-[color:var(--semantic-red)]"}>
            {deltaNation >= 0 ? "+" : ""}{deltaNation}% vs AU
          </span>
        ) : null}
      </div>
      <Row name="Suburb" v={suburb} cls="bg-[hsl(24_92%_50%)]" />
      <Row name="State" v={state} cls="bg-foreground/40" href={stateHref} />
      <Row name="Nation" v={nation} cls="bg-foreground/20" href={nationHref} />
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-10 w-1/3 animate-pulse rounded bg-muted" />
      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <div className="space-y-6">
          <div className="h-[340px] animate-pulse rounded-xl bg-muted" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-20 animate-pulse rounded-lg bg-muted" />)}
          </div>
        </div>
        <div className="h-[280px] animate-pulse rounded-xl bg-muted" />
      </div>
    </div>
  );
}
