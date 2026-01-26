import Stripe from "stripe";

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error("STRIPE_SECRET_KEY is not set");
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2025-12-15.clover",
  typescript: true,
});

// Subscription tiers configuration
export const SUBSCRIPTION_TIERS = {
  free: {
    name: "Free",
    priceId: null,
    requestsPerDay: 100,
    features: ["Public endpoints only", "100 requests/day", "Community support"],
  },
  pro: {
    name: "Pro",
    priceId: process.env.STRIPE_PRO_PRICE_ID,
    requestsPerDay: 10000,
    features: [
      "All endpoints",
      "10,000 requests/day",
      "Priority support",
      "Token management",
    ],
  },
  enterprise: {
    name: "Enterprise",
    priceId: process.env.STRIPE_ENTERPRISE_PRICE_ID,
    requestsPerDay: -1, // unlimited
    features: [
      "All endpoints",
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
