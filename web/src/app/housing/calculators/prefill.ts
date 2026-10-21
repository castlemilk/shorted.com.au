import { isStampDutyState, type StampDutyState } from "@/lib/housing/stamp-duty";

/**
 * Where the calculators start. A suburb profile links here with its median as
 * `?price=` and its state as `?state=`; without them the calculators start
 * from the national mean dwelling price (the page's live default).
 *
 * The query is read in the browser (calculator-prefill.tsx), never on the
 * server: a server searchParams read makes Next render the page per request,
 * which left its `revalidate = 3600` inert (`private, no-store`, 2026-10-21).
 * Pure so the server page can render the unprefilled state from it too.
 */

const PRICE_MIN = 100_000;
const PRICE_MAX = 5_000_000;
const LOAN_MIN = 50_000;
const LOAN_MAX = 3_000_000;

export interface CalculatorPrefill {
  price: number;
  state: StampDutyState;
  /** The mortgage simulator's loan: 80% of the price, in $10k steps. */
  initialLoan: number;
  /** The query carried a price: the visitor came from a suburb page. */
  prefilled: boolean;
  /** The query named a state. */
  stateGiven: boolean;
}

function parsePrice(raw: string | null, fallback: number): number {
  const n = Number(raw);
  if (!raw || !Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(PRICE_MAX, Math.max(PRICE_MIN, Math.round(n / 1000) * 1000));
}

function parseState(raw: string | null): StampDutyState {
  const up = (raw ?? "").toUpperCase();
  return isStampDutyState(up) ? up : "NSW";
}

/** The calculators' starting values for a query, or for none (`null`). */
export function resolvePrefill(
  query: Pick<URLSearchParams, "get"> | null,
  liveDefault: number,
): CalculatorPrefill {
  const rawPrice = query?.get("price") ?? null;
  const rawState = query?.get("state") ?? null;
  const price = parsePrice(rawPrice, liveDefault);
  return {
    price,
    state: parseState(rawState),
    initialLoan: Math.min(LOAN_MAX, Math.max(LOAN_MIN, Math.round((price * 0.8) / 10_000) * 10_000)),
    prefilled: Boolean(rawPrice),
    stateGiven: Boolean(rawState),
  };
}
