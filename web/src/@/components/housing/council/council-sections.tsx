// NO "use client" — server-rendered sections of the council hub. Pure props in,
// markup out; every number is already on GetCouncilProfileResponse. Absent
// facts are omitted (never shown as 0), and a section dates its figures
// wherever the data carries a date.
import Link from "next/link";
import type { ReactNode } from "react";
import type {
  CouncilCrimeStat,
  CouncilNeighbour,
  CouncilPriceDrops,
  CouncilProfile,
  CouncilRepresentative,
  CouncilRollup,
  CouncilSuburb,
  LgaInfo,
} from "~/gen/shorts/v1alpha1/housing_pb";
import { DropsStaleNotice } from "@/components/housing/price-drops/drops-stale-notice";
import { councilHref, crossBorderJurisdiction } from "@/lib/housing/council";
import { dropsFreshness, fmtDropsDate } from "@/lib/housing/drops-freshness";
import {
  fmtInt, fmtMoney, fmtMonth, fmtShare, fmtSharePct, fmtSignedPct, type KeyFact,
} from "@/lib/housing/council-page";
import { fmtPriceShort } from "@/lib/housing/price-scale";
import { stateSlug, suburbHref, titleCaseName } from "@/lib/housing/states";
import { websiteLabel } from "../suburb-council-card";

export function Section({ id, title, lede, children }: { id: string; title: string; lede?: ReactNode; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-heading`} className="space-y-3">
      <div className="max-w-3xl">
        <h2 id={`${id}-heading`} className="font-serif text-2xl font-semibold tracking-tight">{title}</h2>
        {lede ? <p className="mt-1 text-sm leading-relaxed text-muted-foreground [text-wrap:pretty]">{lede}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function KeyFactTiles({ facts }: { facts: readonly KeyFact[] }) {
  if (facts.length === 0) return null;
  return (
    <section aria-label="Key facts" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
      {facts.map((f) => (
        <div key={f.label} className="rounded-xl border border-border/60 bg-card/60 p-4">
          <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{f.label}</h3>
          <p className="mt-1.5 text-xl font-semibold tabular-nums tracking-tight sm:text-2xl">{f.value}</p>
          <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{f.note}</p>
        </div>
      ))}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border/40 py-1.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-medium tabular-nums text-foreground">{children}</dd>
    </div>
  );
}

/** Census 2021 medians, tenure and SEIFA — each row only where it is covered. */
export function PeopleAndHousing({ council: c }: { council: LgaInfo }) {
  const rows: Array<[string, string]> = [];
  if (c.medianAge !== undefined) rows.push(["Median age", `${Math.round(c.medianAge)}`]);
  if (c.medianHhdIncome !== undefined) rows.push(["Median household income", `${fmtMoney(c.medianHhdIncome)}/week`]);
  if (c.medianWeeklyRent !== undefined) rows.push(["Median rent", `${fmtMoney(c.medianWeeklyRent)}/week`]);
  if (c.medianMortgageMonthly !== undefined) rows.push(["Median mortgage repayment", `${fmtMoney(c.medianMortgageMonthly)}/month`]);
  if (c.pctRented !== undefined) rows.push(["Households renting", `${c.pctRented.toFixed(1)}%`]);
  if (c.avgHouseholdSize !== undefined) rows.push(["Average household", `${c.avgHouseholdSize.toFixed(1)} people`]);
  const seifa: Array<[string, string]> = [];
  if (c.seifaIrsadDecile !== undefined) seifa.push(["Advantage and disadvantage (IRSAD)", `decile ${c.seifaIrsadDecile} of 10`]);
  if (c.seifaIrsdDecile !== undefined) seifa.push(["Disadvantage (IRSD)", `decile ${c.seifaIrsdDecile} of 10`]);
  if (rows.length === 0 && seifa.length === 0) return null;
  return (
    <Section id="people" title="People and housing" lede="Council-wide figures from the ABS Census of 2021 and SEIFA 2021 (national deciles, 10 = most advantaged).">
      <div className="grid gap-4 sm:grid-cols-2">
        {rows.length ? (
          <dl className="rounded-xl border border-border/60 bg-card/40 px-4 py-2 text-sm">
            {rows.map(([l, v]) => <Row key={l} label={l}>{v}</Row>)}
          </dl>
        ) : null}
        {seifa.length ? (
          <dl className="rounded-xl border border-border/60 bg-card/40 px-4 py-2 text-sm">
            {seifa.map(([l, v]) => <Row key={l} label={l}>{v}</Row>)}
          </dl>
        ) : null}
      </div>
    </Section>
  );
}

/**
 * Council finances, where a state publishes them (Victoria's LGPRF today). The
 * zeros LgaInfo carries for "no data" are never shown: the block needs a rate.
 */
export function CouncilFinances({ council: c }: { council: LgaInfo }) {
  if (!(c.avgRates > 0) || !c.finSource) return null;
  const source = c.finSource === "vic_lgprf" ? "Local Government Victoria's Performance Reporting Framework (LGPRF)" : "the state's council performance reporting";
  return (
    <Section
      id="finances"
      title="Council finances"
      lede={`From ${source}${c.finYear ? `, ${c.finYear}` : ""}.`}
    >
      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat label="Average rates per property" value={fmtMoney(c.avgRates)} note={c.finYear || undefined} />
        <Stat label="Operating result" value={fmtSignedPct(c.opSurplusRatio)} note="adjusted underlying result; negative = deficit" />
        {c.assetRenewalRatio > 0 ? (
          <Stat label="Asset renewal" value={`${Math.round(c.assetRenewalRatio)}%`} note="renewal and upgrade spend vs depreciation" />
        ) : null}
      </dl>
    </Section>
  );
}

/** Member suburbs: dominant ones, then straddlers at 5%+ with their share. */
export function MemberSuburbs({
  stateCode, suburbs, councilName,
}: { stateCode: string; suburbs: readonly CouncilSuburb[]; councilName: string }) {
  if (suburbs.length === 0) return null;
  const straddlers = suburbs.filter((s) => !s.dominant).length;
  const anyHazard = suburbs.some((s) => s.floodSharePct !== undefined || s.bushfireSharePct !== undefined);
  return (
    <Section
      id="suburbs"
      title="Suburbs"
      lede={
        <>
          {fmtInt(suburbs.length - straddlers)} suburb{suburbs.length - straddlers === 1 ? "" : "s"} where {councilName} holds most residents
          {straddlers ? <>, plus {fmtInt(straddlers)} it shares with a neighbouring council (share of residents shown)</> : null}. Population is
          Census 2021 for the whole suburb. A median here is the suburb&rsquo;s own Valuer-General median — suburbs without one are blank,
          never filled with the council figure.
        </>
      }
    >
      <div className="overflow-x-auto rounded-xl border border-border/60">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-muted/40 text-left text-[11px] uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Suburb</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Population</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">In this council</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Median house (VG)</th>
              {anyHazard ? <th scope="col" className="px-3 py-2 text-right font-medium">Flood / bushfire</th> : null}
              <th scope="col" className="px-3 py-2 text-right font-medium">IRSAD</th>
            </tr>
          </thead>
          <tbody>
            {suburbs.map((s) => (
              <tr key={s.salCode} className="border-t border-border/40">
                <td className="px-3 py-1.5">
                  <Link href={suburbHref(stateCode, s)} className="font-medium hover:underline">{titleCaseName(s.salName)}</Link>
                  {s.postcode ? <span className="ml-1.5 text-[11px] text-muted-foreground">{s.postcode}</span> : null}
                </td>
                <td className="px-3 py-1.5 text-right tabular-nums">{s.population > 0 ? fmtInt(s.population) : ""}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{s.dominant && s.share >= 0.995 ? "All" : fmtShare(s.share)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">
                  {s.vgMedian !== undefined && s.vgMedianPeriod ? (
                    <>
                      {fmtPriceShort(s.vgMedian)}
                      <span className="ml-1 text-[10px] text-muted-foreground">{fmtMonth(s.vgMedianPeriod)}</span>
                    </>
                  ) : null}
                </td>
                {anyHazard ? (
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted-foreground">
                    {s.floodSharePct !== undefined ? fmtSharePct(s.floodSharePct) : "–"} / {s.bushfireSharePct !== undefined ? fmtSharePct(s.bushfireSharePct) : "–"}
                  </td>
                ) : null}
                <td className="px-3 py-1.5 text-right tabular-nums">{s.seifaIrsadDecile ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

const CRIME_LABEL: Record<string, string> = {
  break_ins: "Break and enter", violent: "Violent crime", motor_vehicle: "Motor vehicle theft",
};

/** Hazard + price rollups over member suburbs, and crime where a source covers them. */
export function Rollups({
  stateCode, rollup, pricedPeriods = [],
}: {
  stateCode: string;
  rollup: CouncilRollup;
  /** vg_median_period of the dominant priced member suburbs ('YYYY-MM-DD'). */
  pricedPeriods?: readonly string[];
}) {
  const hazards: Array<{ label: string; value: number; covered: number; overlay: string }> = [];
  if (rollup.floodSharePct !== undefined) hazards.push({ label: "Flood planning land", value: rollup.floodSharePct, covered: rollup.floodCoveredSuburbs, overlay: "flood_planning" });
  if (rollup.bushfireSharePct !== undefined) hazards.push({ label: "Bushfire-prone land", value: rollup.bushfireSharePct, covered: rollup.bushfireCoveredSuburbs, overlay: "bushfire_prone" });
  if (rollup.waterSharePct !== undefined) hazards.push({ label: "Observed surface water (1986–present)", value: rollup.waterSharePct, covered: rollup.waterCoveredSuburbs, overlay: "water_observed" });
  const priced = rollup.pricedSuburbs > 0 && rollup.medianMin !== undefined && rollup.medianMax !== undefined;
  const periods = [...new Set(pricedPeriods)].sort();
  const periodNote = periods.length === 0 ? "each suburb's latest period"
    : periods.length === 1 ? `periods ending ${fmtMonth(periods[0]!)}`
    : `periods ending ${fmtMonth(periods[0]!)} to ${fmtMonth(periods[periods.length - 1]!)}`;
  const crime: readonly CouncilCrimeStat[] = rollup.crime ?? [];
  if (!hazards.length && !priced && !crime.length) return null;
  return (
    <>
      {hazards.length ? (
        <Section
          id="hazards"
          title="Hazards"
          lede="Share of each member suburb's land inside the mapped layer, averaged across the council weighted by the residents each suburb contributes. Only suburbs a source covers count; the rest are left out, not counted as zero."
        >
          <div className="grid gap-3 sm:grid-cols-3">
            {hazards.map((h) => (
              <div key={h.label} className="rounded-xl border border-border/60 bg-card/40 p-4">
                <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{h.label}</h3>
                <p className="mt-1.5 text-2xl font-semibold tabular-nums">{fmtSharePct(h.value)}</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Over {fmtInt(h.covered)} of {fmtInt(rollup.memberSuburbs)} member suburb{rollup.memberSuburbs === 1 ? "" : "s"}
                  {h.covered < rollup.memberSuburbs ? " (the rest are not mapped)" : ""}
                </p>
                <Link href={`/housing/${stateSlug(stateCode)}?overlays=${h.overlay}`} className="mt-2 inline-block text-[11px] text-primary hover:underline">
                  Show the layer on the map →
                </Link>
              </div>
            ))}
          </div>
        </Section>
      ) : null}
      {priced ? (
        <Section
          id="prices"
          title="Suburb prices"
          lede={`Across the ${fmtInt(rollup.pricedSuburbs)} member suburb${rollup.pricedSuburbs === 1 ? "" : "s"} with their own Valuer-General median (unweighted; each suburb's latest figure, ${periodNote}).`}
        >
          <dl className="grid gap-3 sm:grid-cols-3">
            <Stat label="Lowest suburb median" value={fmtPriceShort(rollup.medianMin!)} />
            {rollup.medianOfMedians !== undefined ? <Stat label="Median of suburb medians" value={fmtPriceShort(rollup.medianOfMedians)} /> : null}
            <Stat label="Highest suburb median" value={fmtPriceShort(rollup.medianMax!)} />
          </dl>
        </Section>
      ) : null}
      {crime.length ? (
        <Section
          id="crime"
          title="Recorded crime"
          lede={`Offences per 100,000 residents over the ${fmtInt(Math.max(...crime.map((c) => c.coveredSuburbs)))} member suburbs the source covers, financial year ending ${Math.max(...crime.map((c) => c.fyEnding))}. Small suburbs and unreliable rates are excluded.`}
        >
          <dl className="grid gap-3 sm:grid-cols-3">
            {crime.map((c) => (
              <Stat key={c.crimeType} label={CRIME_LABEL[c.crimeType] ?? c.crimeType} value={fmtInt(c.ratePer100k)} note={`per 100k · ${c.sourceJurisdiction} ${c.fyEnding}`} />
            ))}
          </dl>
        </Section>
      ) : null}
    </>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <dt className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className="mt-1.5 text-xl font-semibold tabular-nums">{value}</dd>
      {note ? <dd className="mt-0.5 text-[11px] text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

function SeatList({ title, seats }: { title: string; seats: readonly CouncilRepresentative[] }) {
  if (!seats.length) return null;
  return (
    <div className="rounded-xl border border-border/60 bg-card/40 p-4">
      <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">{title}</h3>
      <ul className="mt-2 space-y-1.5 text-sm">
        {seats.map((s) => (
          <li key={s.name} className="flex items-baseline justify-between gap-3">
            <span>
              <span className="font-medium">{s.name}</span>
              {s.member ? <span className="text-muted-foreground"> · {s.member}{s.partyAb ? ` (${s.partyAb})` : ""}</span> : null}
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">{fmtShare(s.populationShare)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Representation({ federal, state }: { federal: readonly CouncilRepresentative[]; state: readonly CouncilRepresentative[] }) {
  if (!federal.length && !state.length) return null;
  return (
    <Section
      id="representation"
      title="Representation"
      lede="Federal electorates and state districts covering the council, by share of the residents its suburbs contribute (each suburb counts once, for the seat containing a representative interior point)."
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <SeatList title="Federal electorates" seats={federal} />
        <SeatList title="State districts" seats={state} />
      </div>
    </Section>
  );
}

export function PriceDropsPulse({ stateCode, drops }: { stateCode: string; drops: CouncilPriceDrops | undefined }) {
  if (!drops) return null;
  // The /price-drops freshness rules, not a local copy: dated in Sydney time
  // with a fixed month table, and flagged stale past DROPS_STALE_AFTER_HOURS.
  // Judged at render, so with this page's 24h ISR the notice can trail the 72h
  // mark by up to a day; the dates in the lede are exact either way.
  const freshness = dropsFreshness(drops);
  const asOf = freshness.asOfIso ? fmtDropsDate(new Date(freshness.asOfIso)) : undefined;
  const through = freshness.dataThroughIso ? fmtDropsDate(new Date(freshness.dataThroughIso)) : undefined;
  return (
    <Section
      id="price-drops"
      title="Asking-price cuts"
      lede={
        <>
          Cuts in the last 30 days to listings the Shorted crawl has seen in the last 14 days, across {fmtInt(drops.suburbsTracked)} suburb
          {drops.suburbsTracked === 1 ? "" : "s"} of this council. An aggregate only: published at 3 or more cut listings council-wide
          (cuts in every crawled suburb count), and a suburb is named only when it has 3 of its own.
          {asOf ? <> Computed {asOf}{through ? <>; newest crawl observation {through}</> : null}.</> : null}
        </>
      }
    >
      <DropsStaleNotice freshness={freshness} scope="in this section" testId="council-drops-stale" />
      <dl className="grid gap-3 sm:grid-cols-3">
        <Stat label="Listings cut" value={fmtInt(drops.droppedListingCount)} note={`of ${fmtInt(drops.trackedListingCount)} tracked`} />
        <Stat label="Share cut" value={`${(drops.droppedShare * 100).toFixed(1)}%`} />
        {drops.medianDropPct !== undefined ? <Stat label="Typical cut" value={`${(drops.medianDropPct * 100).toFixed(1)}%`} note="median over every cut listing" /> : null}
      </dl>
      {drops.suburbs?.length ? (
        <p className="text-sm text-muted-foreground">
          Most cuts:{" "}
          {drops.suburbs.slice(0, 6).map((s, i) => (
            <span key={s.salCode}>
              {i > 0 ? ", " : ""}
              <Link href={suburbHref(stateCode, s)} className="text-foreground hover:underline">{titleCaseName(s.salName)}</Link> ({fmtInt(s.droppedListingCount)})
            </span>
          ))}
          .{" "}
          <Link href={`/price-drops?state=${stateSlug(stateCode)}`} className="text-primary hover:underline">All price drops →</Link>
        </p>
      ) : null}
    </Section>
  );
}

/** A neighbour chip: linked to the council's own state URL when it has a page. */
function NeighbourChip({ n, detail }: { n: CouncilNeighbour; detail: string }) {
  const href = councilHref(n.stateCode, n.slug);
  const label = <>{n.displayName}{detail ? <span className="ml-1 text-[10px] text-muted-foreground">{detail}</span> : null}</>;
  return (
    <li>
      {href ? (
        <Link href={href} className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-sm hover:bg-muted">{label}</Link>
      ) : (
        <span className="inline-flex items-center rounded-md border border-border/50 px-2.5 py-1 text-sm text-muted-foreground">{label}</span>
      )}
    </li>
  );
}

/**
 * Same-state neighbours (suburb topology + split suburbs), then the councils
 * across a state or territory border whose ABS boundaries touch this one's.
 * A neighbour is cross-border when its state is not this council's.
 */
export function Neighbours({ neighbours, stateCode }: { neighbours: readonly CouncilNeighbour[]; stateCode: string }) {
  if (!neighbours.length) return null;
  const same = neighbours.filter((n) => n.stateCode === stateCode);
  const across = neighbours.filter((n) => n.stateCode !== stateCode);
  return (
    <Section
      id="neighbours"
      title="Neighbouring councils"
      lede={
        across.length
          ? "Councils whose suburbs share a boundary with this one's, councils it splits a suburb with, and councils across the state or territory border whose boundaries meet it."
          : "Councils in the same state whose suburbs share a boundary with this one's, and councils it splits a suburb with."
      }
    >
      {same.length ? (
        <ul className="flex flex-wrap gap-2">
          {same.map((n) => (
            <NeighbourChip
              key={n.lgaCode}
              n={n}
              detail={[n.sharesBorder ? "" : "shares suburbs", n.sharedSuburbs > 0 && n.sharesBorder ? `${n.sharedSuburbs} shared suburb${n.sharedSuburbs === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ")}
            />
          ))}
        </ul>
      ) : null}
      {across.length ? (
        <div className="space-y-2">
          <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Across the border</h3>
          <ul className="flex flex-wrap gap-2" aria-label="Neighbouring councils across the border">
            {across.map((n) => (
              <NeighbourChip key={n.lgaCode} n={n} detail={crossBorderJurisdiction(n.stateCode)} />
            ))}
          </ul>
        </div>
      ) : null}
    </Section>
  );
}

export function CouncilWebsite({ website }: { website: string }) {
  if (!website) return null;
  return (
    <a href={website} rel="noopener noreferrer" target="_blank" className="text-primary underline-offset-2 hover:underline">
      {websiteLabel(website)}
    </a>
  );
}

/** "ABS, Dept of Infrastructure and state government" — only licensors whose data is shown. */
function licensors(grants: boolean, lgprf: boolean): string {
  const names = ["ABS", grants ? "Dept of Infrastructure" : "", lgprf ? "Local Government Victoria" : "", "state government"].filter(Boolean);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** One sources line naming every licensor whose data the page shows. */
export function SourcesLine({ profile: p }: { profile: CouncilProfile }) {
  const c = p.council!;
  const s = p.summary!;
  const measures = new Set((p.series ?? []).map((x) => x.measure));
  const parts = [
    `Boundaries: ${p.lgaVintage}; suburbs allocated by 2021 mesh block, weighted by Census 2021 residents.`,
    s.population > 0 ? `Population: ABS estimated resident population ${s.erpYear}.` : "",
    c.medianAge !== undefined || c.seifaIrsadDecile !== undefined ? "Census 2021 and SEIFA 2021: ABS." : "",
    measures.has("house_median_price") || measures.has("attached_median_price") ? "Council-wide medians: ABS Data by Region." : "",
    measures.has("dwelling_approvals_total") ? "Approvals: ABS Building Approvals." : "",
    c.fedFagAud > 0 || measures.has("fag_total_aud") ? "Grants: Financial Assistance Grants, Dept of Infrastructure." : "",
    c.finSource === "vic_lgprf" && c.avgRates > 0 ? `Financials: Local Government Victoria (LGPRF)${c.finYear ? `, ${c.finYear}` : ""}.` : "",
    (p.suburbs ?? []).some((x) => x.vgMedian !== undefined) ? "Suburb prices: state Valuer-General." : "",
    p.rollup && (p.rollup.floodSharePct !== undefined || p.rollup.bushfireSharePct !== undefined) ? "Flood and bushfire: state planning layers." : "",
    p.rollup?.waterSharePct !== undefined ? "Observed water: Geoscience Australia DEA Water Observations." : "",
    p.rollup?.crime?.length ? "Crime: state police statistics." : "",
    p.priceDrops ? "Asking-price cuts: Shorted listing crawl, aggregates only." : "",
    c.website || c.wikidataQid ? "Website and identity: Wikidata (CC0)." : "",
  ].filter(Boolean);
  return (
    <p className="border-t border-border/50 pt-4 text-[11px] leading-relaxed text-muted-foreground [text-wrap:pretty]">
      {parts.join(" ")} {licensors(c.fedFagAud > 0 || measures.has("fag_total_aud"), c.finSource === "vic_lgprf" && c.avgRates > 0)} data CC BY 4.0.
      {p.factsAsOf ? ` Council facts loaded ${p.factsAsOf}.` : ""}
    </p>
  );
}

