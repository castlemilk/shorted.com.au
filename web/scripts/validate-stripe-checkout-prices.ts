import Stripe from "stripe";
import {
  validateConfiguredCheckoutPrices,
  type CheckoutPricePreflightResult,
} from "../src/lib/stripe-plans";

const stripeSecretKey = process.env.STRIPE_SECRET_KEY?.trim();

if (!stripeSecretKey) {
  console.error("Stripe checkout price preflight failed: STRIPE_SECRET_KEY is not configured.");
  process.exit(1);
}

const stripe = new Stripe(stripeSecretKey, {
  apiVersion: "2025-12-15.clover",
  typescript: true,
});

const results = await validateConfiguredCheckoutPrices({
  retrievePrice: (priceId) => stripe.prices.retrieve(priceId),
});

let failed = false;
for (const result of results) {
  if (!result.ok) {
    failed = true;
    console.error(formatResult(result));
    continue;
  }

  console.log(formatResult(result));
}

if (failed) {
  process.exit(1);
}

function formatResult(result: CheckoutPricePreflightResult): string {
  if (result.ok && "skipped" in result) {
    return `Stripe ${result.tier} price preflight skipped: ${result.reason}`;
  }

  if (result.ok) {
    return `Stripe ${result.tier} price preflight passed: ${result.envName}=${maskPriceId(result.priceId)}`;
  }

  const priceSuffix = result.priceId
    ? ` (${result.envName}=${maskPriceId(result.priceId)})`
    : "";
  return `Stripe ${result.tier} price preflight failed${priceSuffix}: ${sanitizeMessage(
    result.message,
    result.priceId,
  )}`;
}

function sanitizeMessage(message: string, priceId?: string): string {
  if (!priceId) {
    return message;
  }

  return message.split(priceId).join(maskPriceId(priceId));
}

function maskPriceId(priceId: string): string {
  if (priceId.length <= 14) {
    return "price_...";
  }

  return `${priceId.slice(0, 8)}...${priceId.slice(-6)}`;
}
