import type { StateCensusAverages, SuburbDemographics } from "~/gen/shorts/v1alpha1/housing_pb";
import { HousingIcon, type HousingIconName } from "./housing-icon";

// Server components: no hooks, no handlers, no connect imports — markup over an
// already-resolved GetSuburbProfile response. The generated types are
// type-only imports and vanish at compile time.
//
// Reading the wire: these Census shares are plain proto3 doubles, so an absent
// value arrives as 0 and a measured 0 does too. The collector withholds whole
// groups (tenure; house vs flat; the household mix; low vs high income) on a
// shared denominator floor and when the group is internally inconsistent
// (census_expanded.go), so a group with ANY member above 0 was measured in
// full and its zeros are real. A standalone rate (unemployment, participation,
// bachelor+) has no such sibling, so 0 is read as "not published" and the stat
// is left out — withholding a real 0 rather than publishing a floored one.

type Share = { label: string; value: number; tone: string };

/** One Census group, or null when the collector withheld it. */
function measuredGroup(values: number[]): number[] | null {
  return values.some((v) => v > 0) ? values : null;
}

const pct = (v: number) => `${Math.round(v)}%`;

/** "+4 pts vs NSW" — a difference of shares is in percentage points, never %. */
function pointsVs(value: number, base: number | undefined, stateCode: string): string | null {
  if (!base || base <= 0) return null;
  const diff = Math.round(value - base);
  if (diff === 0) return `level with ${stateCode}`;
  return `${diff > 0 ? "+" : "−"}${Math.abs(diff)} pts vs ${stateCode}`;
}

function Heading({ icon, id, children }: { icon: HousingIconName; id: string; children: string }) {
  return (
    <h2 id={id} className="mb-3 flex items-center gap-2.5 font-serif text-2xl text-foreground">
      <HousingIcon name={icon} size={26} /> {children}
    </h2>
  );
}

/**
 * A 100% stacked bar of mutually exclusive shares plus a legend. The remainder
 * (Census "other" + "not stated") is drawn and named rather than stretched away,
 * so the bar never implies the named parts cover everyone.
 */
function StackedShares({
  label, shares, remainderLabel, stateLine,
}: {
  label: string; shares: Share[]; remainderLabel: string; stateLine: string | null;
}) {
  const named = shares.reduce((sum, s) => sum + s.value, 0);
  const remainder = Math.max(0, 100 - named);
  return (
    <figure aria-label={label}>
      <figcaption className="text-xs text-foreground">{label}</figcaption>
      <div className="mt-2 flex h-3.5 overflow-hidden rounded bg-muted" aria-hidden>
        {shares.map((s) => (
          <span key={s.label} className={s.tone} style={{ width: `${Math.min(100, s.value)}%` }} />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {shares.map((s) => (
          <li key={s.label} className="flex items-center gap-1.5">
            <span aria-hidden className={`inline-block h-2 w-2 rounded-sm ${s.tone}`} />
            {s.label} <span className="font-mono tabular-nums text-foreground">{pct(s.value)}</span>
          </li>
        ))}
        {remainder >= 0.5 ? (
          <li className="flex items-center gap-1.5">
            <span aria-hidden className="inline-block h-2 w-2 rounded-sm bg-muted" />
            {remainderLabel} <span className="font-mono tabular-nums">{pct(remainder)}</span>
          </li>
        ) : null}
      </ul>
      {stateLine ? <p className="mt-1 text-[10px] text-muted-foreground">{stateLine}</p> : null}
    </figure>
  );
}

type Stat = { key: string; label: string; value: number; note: string | null };

function StatGrid({ stats }: { stats: Stat[] }) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <dl className="-mb-px -mr-px grid grid-cols-2 sm:grid-cols-3">
        {stats.map((s) => (
          <div key={s.key} className="border-b border-r border-border px-3.5 py-3">
            <dt className="text-[11px] leading-tight text-muted-foreground">{s.label}</dt>
            <dd className="mt-0.5 font-mono text-[15px] font-semibold tabular-nums text-foreground">{pct(s.value)}</dd>
            {s.note ? <dd className="mt-0.5 text-[10px] text-muted-foreground">{s.note}</dd> : null}
          </div>
        ))}
      </dl>
    </div>
  );
}

const CENSUS_FOOTNOTE =
  "ABS Census 2021 (CC BY 4.0). Withheld for very small populations — under 100 residents, or under 50 dwellings, households or workers for the shares that count those.";

/**
 * Housing stock: how many occupied dwellings, what kind, and who owns them.
 * Renders nothing when the suburb has none of it (a pseudo-SAL, or a locality
 * below every floor).
 */
export function SuburbHousingStockCard({
  d, state, stateCode,
}: {
  d: SuburbDemographics | undefined; state: StateCensusAverages | undefined; stateCode: string;
}) {
  if (!d) return null;
  const tenure = measuredGroup([d.pctOwnedOutright, d.pctOwnedMortgage, d.pctRented]);
  const structure = measuredGroup([d.pctSeparateHouse, d.pctFlatApartment]);
  if (!tenure && !structure && !(d.dwellingCount > 0)) return null;

  const stateTenure = state && state.pctRented > 0
    ? `${stateCode}: ${pct(state.pctOwnedOutright)} owned outright · ${pct(state.pctOwnedMortgage)} mortgaged · ${pct(state.pctRented)} rented`
    : null;
  const stateStructure = state && state.pctSeparateHouse > 0
    ? `${stateCode}: ${pct(state.pctSeparateHouse)} separate houses · ${pct(state.pctFlatApartment)} flats & apartments`
    : null;

  return (
    <section aria-labelledby="housing-stock-heading">
      <Heading icon="dwellings" id="housing-stock-heading">Housing stock</Heading>
      <div className="flex flex-col gap-5 rounded-xl border border-border bg-card p-5">
        {d.dwellingCount > 0 ? (
          <p className="text-sm text-muted-foreground">
            <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
              {d.dwellingCount.toLocaleString("en-AU")}
            </span>{" "}
            occupied private dwellings
          </p>
        ) : null}
        {structure ? (
          <StackedShares
            label="Dwelling type"
            shares={[
              { label: "Separate house", value: structure[0]!, tone: "bg-primary" },
              { label: "Flat or apartment", value: structure[1]!, tone: "bg-sky-600 dark:bg-sky-400" },
            ]}
            remainderLabel="Semi, terrace & other"
            stateLine={stateStructure}
          />
        ) : null}
        {tenure ? (
          <StackedShares
            label="Tenure"
            shares={[
              { label: "Owned outright", value: tenure[0]!, tone: "bg-primary" },
              { label: "Mortgaged", value: tenure[1]!, tone: "bg-amber-600 dark:bg-amber-400" },
              { label: "Rented", value: tenure[2]!, tone: "bg-sky-600 dark:bg-sky-400" },
            ]}
            remainderLabel="Other & not stated"
            stateLine={stateTenure}
          />
        ) : null}
        <p className="text-[11px] text-muted-foreground [text-wrap:pretty]">{CENSUS_FOOTNOTE}</p>
      </div>
    </section>
  );
}

/**
 * Who lives here: household make-up, work, education and income, each against
 * the state share rebuilt from its suburbs (StateCensusAverages). Renders
 * nothing when every figure was withheld.
 */
export function SuburbWhoLivesHereCard({
  d, state, stateCode,
}: {
  d: SuburbDemographics | undefined; state: StateCensusAverages | undefined; stateCode: string;
}) {
  if (!d) return null;
  const stats: Stat[] = [];
  const add = (key: string, label: string, value: number, base: number | undefined) =>
    stats.push({ key, label, value, note: pointsVs(value, base, stateCode) });

  const household = measuredGroup([d.pctCoupleWithChildren, d.pctLonePersonHousehold]);
  if (household) {
    add("couple-kids", "Couples with children", household[0]!, state?.pctCoupleWithChildren);
    add("lone", "Living alone", household[1]!, state?.pctLonePersonHousehold);
  }
  if (d.unemploymentRate > 0) add("unemployment", "Unemployment", d.unemploymentRate, state?.unemploymentRate);
  if (d.labourForceParticipationRate > 0) {
    add("participation", "In the labour force", d.labourForceParticipationRate, state?.labourForceParticipationRate);
  }
  if (d.pctBachelorOrHigher > 0) add("bachelor", "Bachelor degree or higher", d.pctBachelorOrHigher, state?.pctBachelorOrHigher);
  const income = measuredGroup([d.pctLowPersonalIncome, d.pctHighPersonalIncome]);
  if (income) {
    add("low-income", "Earning $1–$499 a week", income[0]!, state?.pctLowPersonalIncome);
    add("high-income", "Earning $2,000+ a week", income[1]!, state?.pctHighPersonalIncome);
  }
  if (stats.length === 0) return null;

  return (
    <section aria-labelledby="who-lives-here-heading">
      <Heading icon="population" id="who-lives-here-heading">Who lives here</Heading>
      <StatGrid stats={stats} />
      <p className="mt-2 text-[11px] text-muted-foreground [text-wrap:pretty]">
        Households for the family mix, residents aged 15+ for work, education and income; unemployment is a
        share of the labour force. {stateCode} figures weight each suburb by its dwellings or residents.{" "}
        {CENSUS_FOOTNOTE}
      </p>
    </section>
  );
}
