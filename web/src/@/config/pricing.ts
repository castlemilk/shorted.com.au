/**
 * Single source of truth for Shorted's plans and prices.
 *
 * Everything that states or checks a price derives from this file:
 * - checkout validation (`lib/stripe-plans.ts` rejects a Stripe price whose
 *   unit amount / currency / interval does not match `amountCents` here),
 * - the subscription tier table (`lib/stripe.ts`),
 * - every displayed price (/pricing, /about, /docs/api, /roadmap, upsells).
 *
 * To change a price: create the new Stripe price, point the matching
 * STRIPE_*_PRICE_ID env at it, and change `amountCents` here in the same
 * release. Checkout fails closed ("pricing is misconfigured") while the two
 * disagree, so the site can never advertise one price and charge another.
 *
 * Deliberately dependency-free so client components can import it without
 * pulling the Stripe SDK into the bundle.
 */

export const PRICING_CURRENCY = "aud" as const;
export const PRICING_INTERVAL = "month" as const;

export const PLANS = {
  free: {
    name: "Free",
    amountCents: 0,
    tagline:
      "Short positions, charts, industry heatmaps and reports for every ASX stock.",
    features: [
      "Short position data",
      "Weekly reports",
      "Basic stock pages",
      "Portfolio tracking",
    ],
  },
  premium: {
    name: "Premium",
    amountCents: 400,
    tagline: "AI chat, Market Pulse, alerts and advanced dashboards.",
    features: [
      "Everything in Free",
      "AI Chat assistant",
      "Market Pulse dashboard",
      "Price & position alerts",
      "Advanced dashboard widgets",
      "Priority support",
    ],
  },
  apiAccess: {
    name: "API Access",
    amountCents: 2000,
    tagline:
      "API tokens and higher limits for developers and quant workflows.",
    features: [
      "API tokens",
      "Higher request limits",
      "Programmatic data access",
    ],
  },
} as const;

export type PlanKey = keyof typeof PLANS;

/** Whole-dollar amount when exact, else two decimals: 400 -> "$4", 450 -> "$4.50". */
export function formatPrice(amountCents: number): string {
  const dollars = amountCents / 100;
  return `$${Number.isInteger(dollars) ? dollars : dollars.toFixed(2)}`;
}

/** "$4" for a plan. */
export function planPrice(plan: PlanKey): string {
  return formatPrice(PLANS[plan].amountCents);
}

/** "$4/mo" for a plan; "$0" for a free plan. */
export function planPricePerMonth(plan: PlanKey): string {
  const cents = PLANS[plan].amountCents;
  return cents === 0 ? formatPrice(0) : `${formatPrice(cents)}/mo`;
}
