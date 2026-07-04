/**
 * Baked 2025–26 owner-occupier GENERAL-RATE transfer (stamp) duty schedules
 * for the 8 Australian states/territories, for the /housing/calculators page.
 *
 * These are estimates only: concessions (first-home buyer, PPR, pensioner,
 * off-the-plan), foreign-purchaser surcharges, and annual indexation are NOT
 * modelled. Verify with the relevant state revenue office (source URL cited
 * per state below). Unit tests in stamp-duty.test.ts pin known values
 * computed from these bracket tables as regression protection.
 */

export type StampDutyState =
  | "NSW" | "VIC" | "QLD" | "WA" | "SA" | "TAS" | "ACT" | "NT";

export const STAMP_DUTY_STATES: StampDutyState[] = [
  "NSW", "VIC", "QLD", "WA", "SA", "TAS", "ACT", "NT",
];

/**
 * A duty bracket: for a price in [min, next bracket's min), duty is
 * `base + ratePct% × (price − min)` — or, when `ofTotal` is true,
 * `base + ratePct% × price` (some jurisdictions charge a flat rate on the
 * whole value in certain ranges, e.g. VIC $960k–$2M, ACT above ~$1.455M).
 */
export interface DutyBracket {
  min: number;
  base: number;
  ratePct: number;
  ofTotal?: boolean;
}

interface StateSchedule {
  brackets: DutyBracket[];
  /** Minimum duty payable regardless of the bracket result. */
  minDuty?: number;
  /** Short note about first-home-buyer / owner-occupier concessions (not modelled). */
  concessionNote: string;
  /** Revenue-office source. */
  sourceUrl: string;
}

const SCHEDULES: Record<StampDutyState, StateSchedule> = {
  // Revenue NSW — transfer duty, standard rates (thresholds indexed annually):
  // https://www.revenue.nsw.gov.au/taxes-duties-levies-royalties/transfer-duty
  NSW: {
    minDuty: 20,
    brackets: [
      { min: 0, base: 0, ratePct: 1.25 },
      { min: 17_000, base: 212.5, ratePct: 1.5 },
      { min: 36_000, base: 497.5, ratePct: 1.75 },
      { min: 97_000, base: 1_565, ratePct: 3.5 },
      { min: 364_000, base: 10_910, ratePct: 4.5 },
      { min: 1_212_000, base: 49_070, ratePct: 5.5 },
      // Premium rate on residential land over the premium threshold.
      { min: 3_636_000, base: 182_390, ratePct: 7.0 },
    ],
    concessionNote:
      "First-home buyers may pay no duty under $800k and reduced duty to $1M (First Home Buyers Assistance Scheme) — check Revenue NSW.",
    sourceUrl:
      "https://www.revenue.nsw.gov.au/taxes-duties-levies-royalties/transfer-duty",
  },
  // State Revenue Office Victoria — general (non-PPR) land transfer duty rates:
  // https://www.sro.vic.gov.au/land-transfer-duty-current-rates
  VIC: {
    brackets: [
      { min: 0, base: 0, ratePct: 1.4 },
      { min: 25_000, base: 350, ratePct: 2.4 },
      { min: 130_000, base: 2_870, ratePct: 6.0 },
      { min: 960_000, base: 0, ratePct: 5.5, ofTotal: true },
      { min: 2_000_000, base: 110_000, ratePct: 6.5 },
    ],
    concessionNote:
      "Principal-place-of-residence rates apply $130k–$550k, and first-home buyers pay no duty under $600k (concession to $750k) — check the SRO Victoria.",
    sourceUrl: "https://www.sro.vic.gov.au/land-transfer-duty-current-rates",
  },
  // Queensland Revenue Office — transfer duty general rates (home
  // concession rates exist but are not modelled):
  // https://qro.qld.gov.au/duties/transfer-duty/calculate/rates/
  QLD: {
    brackets: [
      { min: 0, base: 0, ratePct: 0 },
      { min: 5_000, base: 0, ratePct: 1.5 },
      { min: 75_000, base: 1_050, ratePct: 3.5 },
      { min: 540_000, base: 17_325, ratePct: 4.5 },
      { min: 1_000_000, base: 38_025, ratePct: 5.75 },
    ],
    concessionNote:
      "A home concession applies to owner-occupiers, and first-home buyers may pay no duty (thresholds raised in 2024–25) — check the Queensland Revenue Office.",
    sourceUrl: "https://qro.qld.gov.au/duties/transfer-duty/calculate/rates/",
  },
  // RevenueWA — residential rate of transfer duty:
  // https://www.wa.gov.au/organisation/department-of-finance/transfer-duty-assessment
  WA: {
    brackets: [
      { min: 0, base: 0, ratePct: 1.9 },
      { min: 360_000, base: 6_840, ratePct: 4.75 },
      { min: 725_000, base: 24_177.5, ratePct: 5.15 },
    ],
    concessionNote:
      "First-home owners may pay no duty under $450k and reduced duty to $600k (higher caps in some regions) — check RevenueWA.",
    sourceUrl:
      "https://www.wa.gov.au/organisation/department-of-finance/transfer-duty-assessment",
  },
  // RevenueSA — stamp duty on transfers of residential land (not indexed):
  // https://www.revenuesa.sa.gov.au/stampduty/stamp-duty-rates
  SA: {
    brackets: [
      { min: 0, base: 0, ratePct: 1.0 },
      { min: 12_000, base: 120, ratePct: 2.0 },
      { min: 30_000, base: 480, ratePct: 3.0 },
      { min: 50_000, base: 1_080, ratePct: 3.5 },
      { min: 100_000, base: 2_830, ratePct: 4.0 },
      { min: 200_000, base: 6_830, ratePct: 4.25 },
      { min: 250_000, base: 8_955, ratePct: 4.75 },
      { min: 300_000, base: 11_330, ratePct: 5.0 },
      { min: 500_000, base: 21_330, ratePct: 5.5 },
    ],
    concessionNote:
      "First-home buyers building or buying a NEW home pay no duty (no price cap since June 2024) — established homes get no FHB relief; check RevenueSA.",
    sourceUrl: "https://www.revenuesa.sa.gov.au/stampduty/stamp-duty-rates",
  },
  // State Revenue Office Tasmania — property transfer duty rates:
  // https://www.sro.tas.gov.au/property-transfer-duties
  TAS: {
    brackets: [
      { min: 0, base: 50, ratePct: 0 },
      { min: 3_000, base: 50, ratePct: 1.75 },
      { min: 25_000, base: 435, ratePct: 2.25 },
      { min: 75_000, base: 1_560, ratePct: 3.5 },
      { min: 200_000, base: 5_935, ratePct: 4.0 },
      { min: 375_000, base: 12_935, ratePct: 4.25 },
      { min: 725_000, base: 27_810, ratePct: 4.5 },
    ],
    concessionNote:
      "First-home buyers of established homes under $750k may pay no duty (100% concession) — check the SRO Tasmania.",
    sourceUrl: "https://www.sro.tas.gov.au/property-transfer-duties",
  },
  // ACT Revenue Office — owner-occupier conveyance duty (rates change every
  // 1 July under the ACT's tax-reform glide path):
  // https://www.revenue.act.gov.au/duties/conveyance-duty
  ACT: {
    minDuty: 20,
    brackets: [
      { min: 0, base: 0, ratePct: 0.4 },
      { min: 260_000, base: 1_040, ratePct: 2.2 },
      { min: 300_000, base: 1_920, ratePct: 3.4 },
      { min: 500_000, base: 8_720, ratePct: 4.32 },
      { min: 750_000, base: 19_520, ratePct: 5.9 },
      { min: 1_000_000, base: 34_270, ratePct: 6.4 },
      { min: 1_455_000, base: 0, ratePct: 4.54, ofTotal: true },
    ],
    concessionNote:
      "The Home Buyer Concession Scheme can reduce duty to nil for eligible buyers (income-tested, no price cap) — check the ACT Revenue Office.",
    sourceUrl: "https://www.revenue.act.gov.au/duties/conveyance-duty",
  },
  // NT Territory Revenue Office — stamp duty on conveyances. Below $525k a
  // quadratic formula applies: D = (0.06571441 × V²) + 15V where V = price/1000.
  // https://nt.gov.au/employ/money-and-taxes/taxes-royalties-and-grants/stamp-duty
  NT: {
    brackets: [
      { min: 525_000, base: 0, ratePct: 4.95, ofTotal: true },
      { min: 3_000_000, base: 0, ratePct: 5.75, ofTotal: true },
      { min: 5_000_000, base: 0, ratePct: 5.95, ofTotal: true },
    ],
    concessionNote:
      "House-and-land package and home-owner concessions may apply — check the NT Territory Revenue Office.",
    sourceUrl:
      "https://nt.gov.au/employ/money-and-taxes/taxes-royalties-and-grants/stamp-duty",
  },
};

/** NT's sub-$525k quadratic duty formula. */
function ntFormula(price: number): number {
  const v = price / 1000;
  return 0.06571441 * v * v + 15 * v;
}

/**
 * Estimated transfer duty for an owner-occupier at general rates.
 * Returns dollars (unrounded); negative/zero prices return 0.
 */
export function calculateStampDuty(state: StampDutyState, price: number): number {
  if (price <= 0) return 0;
  const schedule = SCHEDULES[state];

  if (state === "NT" && price < 525_000) {
    return ntFormula(price);
  }

  // Find the applicable bracket (last one whose min ≤ price).
  let bracket = schedule.brackets[0]!;
  for (const b of schedule.brackets) {
    if (price >= b.min) bracket = b;
    else break;
  }

  const duty = bracket.ofTotal
    ? bracket.base + (bracket.ratePct / 100) * price
    : bracket.base + (bracket.ratePct / 100) * (price - bracket.min);

  return Math.max(duty, schedule.minDuty ?? 0);
}

/** The (unmodelled) concession note + source for a state, for UI display. */
export function stampDutyInfo(state: StampDutyState): {
  concessionNote: string;
  sourceUrl: string;
} {
  const { concessionNote, sourceUrl } = SCHEDULES[state];
  return { concessionNote, sourceUrl };
}

/** Type guard for URL/search-param input. */
export function isStampDutyState(v: string): v is StampDutyState {
  return (STAMP_DUTY_STATES as string[]).includes(v);
}
