import Stripe from "stripe";
import { getPremiumPriceId } from "./stripe-plans";
import { PLANS } from "~/@/config/pricing";

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

// Prefer the dedicated Premium price-id env. STRIPE_PRO_PRICE_ID remains a
// legacy compatibility fallback for older deployments.
const PRO_PRICE_ID = getPremiumPriceId();

// Subscription tiers configuration
export const SUBSCRIPTION_TIERS = {
  free: {
    name: PLANS.free.name,
    priceId: null,
    price: PLANS.free.amountCents / 100,
    requestsPerDay: 100,
    features: PLANS.free.features,
  },
  premium: {
    name: PLANS.premium.name,
    priceId: PRO_PRICE_ID,
    price: PLANS.premium.amountCents / 100,
    requestsPerDay: 10000,
    features: PLANS.premium.features,
  },
  // Backward compat: existing "pro" subscribers treated as premium
  pro: {
    name: PLANS.premium.name,
    priceId: PRO_PRICE_ID,
    price: PLANS.premium.amountCents / 100,
    requestsPerDay: 10000,
    features: PLANS.premium.features,
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
