// Server component. Where this suburb sits in its own state, on the three
// measures we can rank it on honestly.
//
// Every cell is a PERCENTILE, and only a percentile. An earlier pass mixed two
// absolute 0-100 scores (amenity density, NBN tech tier) with two ranks on
// identical arcs, which asserted a common scale that does not exist — "Amenity
// 78" and "Income 78" were unrelated claims drawn as the same claim.
//
// It also carried a "Safety" cell computed as 100 − mean(break-in, violent,
// motor-vehicle percentile). That composite exists nowhere in BOCSAR's data or
// in the RPC; it was invented here, and averaging three offence-type ranks into
// one number is exactly the guess this subsystem's editorial rule forbids. Crime
// keeps its own card, where each offence type is reported separately with its own
// percentile and its own methodology footnote.
//
// And the arcs are gone. A row of half-donut gauges is the most recognisable
// dashboard-template form there is, and at 52x32 with a 5px stroke it could not
// distinguish 62 from 71 anyway — the number did all the work while the arc
// supplied the template smell. A slim rank track reads as a position on a scale,
// which is what a percentile is, and shares its vocabulary with the comparison
// bars further down the page.
//
// Fewer than two rankable measures → no band, rather than a lopsided stub.
import { ordinal, type Ranked } from "@/lib/housing/suburb-stats";
import { STATE_NAMES } from "@/lib/housing/states";

type Cell = {
  key: string;
  label: string;
  /** The percentile itself — this IS the value on the arc. */
  pct: number;
  n: number;
  /** The underlying figure being ranked, e.g. "$3.42M". */
  value: string;
  /** What the n counts — not every state suburb carries every metric. */
  population: string;
};

export type SuburbScoreBandProps = {
  stateCode: string;
  price: Ranked | null;
  priceValue: string;
  income: Ranked | null;
  incomeValue: string;
  amenity: Ranked | null;
  amenityValue: string;
};

export function SuburbScoreBand({
  stateCode,
  price,
  priceValue,
  income,
  incomeValue,
  amenity,
  amenityValue,
}: SuburbScoreBandProps) {
  const stateName = STATE_NAMES[stateCode] ?? stateCode;
  const cells: Cell[] = [];
  if (price) cells.push({ key: "price", label: "Median house price", pct: price.pct, n: price.n, value: priceValue, population: `priced ${stateCode} suburbs` });
  if (income) cells.push({ key: "income", label: "Household income", pct: income.pct, n: income.n, value: incomeValue, population: `${stateCode} suburbs` });
  if (amenity) cells.push({ key: "amenity", label: "Amenity score", pct: amenity.pct, n: amenity.n, value: amenityValue, population: `rated ${stateCode} suburbs` });

  if (cells.length < 2) return null;

  return (
    <section aria-label={`How this suburb ranks among ${stateName} suburbs`}>
      {/* Cell borders rather than a border-coloured container showing through
          gaps — with only two rankable measures, the gap technique leaves a slab
          of raw border colour in the third column. */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        {/* Columns come from the cell count, so two rankable measures give two
            half-width cells rather than two thirds and a reserved blank. */}
        <div className={`-mb-px -mr-px grid grid-cols-1 ${cells.length === 2 ? "sm:grid-cols-2" : "sm:grid-cols-3"}`}>
        {cells.map((c) => (
          <div key={c.key} className="border-b border-r border-border px-4 py-3.5">
            <div className="font-mono text-[11px] uppercase tracking-[0.1em] text-muted-foreground">
              {c.label}
            </div>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="font-mono text-lg font-semibold tabular-nums text-foreground">
                {c.value}
              </span>
              <span className="font-mono text-[11px] tabular-nums text-primary">
                {ordinal(c.pct)} pctile
              </span>
            </div>
            <RankTrack pct={c.pct} label={c.label} />
            <div className="mt-1 text-[11px] leading-tight text-muted-foreground">
              of {c.n.toLocaleString()} {c.population}
            </div>
          </div>
        ))}
        </div>
      </div>
    </section>
  );
}

/**
 * A percentile as a position on a track. Amber above the top third,
 * foreground-toned below, so colour tracks the VALUE rather than which metric it
 * is: a rank of 12 and a rank of 94 must never look equally emphatic.
 */
function RankTrack({ pct, label }: { pct: number; label: string }) {
  const v = Math.min(100, Math.max(0, pct));
  return (
    <div
      role="img"
      aria-label={`${label}: ${ordinal(v)} percentile`}
      className="relative mt-2 h-1.5 rounded-sm bg-muted"
    >
      <div
        className={`absolute inset-y-0 left-0 rounded-sm ${v >= 66 ? "bg-primary" : "bg-foreground/45"}`}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}
