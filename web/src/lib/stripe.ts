import Stripe from "stripe";

// Defer the check to runtime to allow builds to succeed
// The actual Stripe client is only used in API routes at runtime
const getStripeClient = () => {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is not set");
  }
  return new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: "2025-12-15.clover",
    typescript: true,
  });
};

// Lazy initialization - only creates the client when first accessed
let _stripe: Stripe | null = null;
export const stripe = new Proxy({} as Stripe, {
  get(_, prop) {
    if (!_stripe) {
      _stripe = getStripeClient();
    }
    return _stripe[prop as keyof Stripe];
  },
});

// Canonical price-id env is STRIPE_PRO_PRICE_ID.
// Keep STRIPE_PREMIUM_PRICE_ID as a compatibility fallback during migration.
const PRO_PRICE_ID =
  process.env.STRIPE_PRO_PRICE_ID ??
  process.env.STRIPE_PREMIUM_PRICE_ID ??
  null;

// Subscription tiers configuration
export const SUBSCRIPTION_TIERS = {
  free: {
    name: "Free",
    priceId: null,
    price: 0,
    requestsPerDay: 100,
    features: [
      "Short position data",
      "Weekly reports",
      "Basic stock pages",
      "Portfolio tracking",
    ],
  },
  premium: {
    name: "Premium",
    priceId: PRO_PRICE_ID,
    price: 4,
    requestsPerDay: 10000,
    features: [
      "Everything in Free",
      "AI Chat assistant",
      "Market Pulse dashboard",
      "Price & position alerts",
      "Advanced dashboard widgets",
      "Priority support",
    ],
  },
  // Backward compat — existing "pro" subscribers treated as premium
  pro: {
    name: "Premium",
    priceId: PRO_PRICE_ID,
    price: 4,
    requestsPerDay: 10000,
    features: [
      "Everything in Free",
      "AI Chat assistant",
      "Market Pulse dashboard",
      "Price & position alerts",
      "Advanced dashboard widgets",
      "Priority support",
    ],
  },
  enterprise: {
    name: "Enterprise",
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID ?? null,
    price: 0,
    requestsPerDay: -1,
    features: [
      "Everything in Premium",
      "Unlimited requests",
      "Dedicated support",
      "SLA guarantee",
      "Custom integrations",
    ],
  },
} as const;

export type SubscriptionTier = keyof typeof SUBSCRIPTION_TIERS;
export type SubscriptionStatus =
  | "active"
  | "canceled"
  | "past_due"
  | "inactive"
  | "trialing";

/** Returns true if the given tier has premium-level access */
export function isPremiumTier(tier: SubscriptionTier): boolean {
  return tier === "premium" || tier === "pro" || tier === "enterprise";
}
