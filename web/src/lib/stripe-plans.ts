export const CHECKOUT_PLAN_CONFIG = {
  premium: {
    displayName: "Premium",
    priceEnvNames: ["STRIPE_PREMIUM_PRICE_ID", "STRIPE_PRO_PRICE_ID"],
    expectedUnitAmount: 400,
    expectedCurrency: "aud",
    expectedInterval: "month",
  },
  api_access: {
    displayName: "API Access",
    priceEnvNames: ["STRIPE_API_ACCESS_PRICE_ID"],
    expectedUnitAmount: 2000,
    expectedCurrency: "aud",
    expectedInterval: "month",
  },
} as const;

export type CheckoutTier = keyof typeof CHECKOUT_PLAN_CONFIG;

type EnvLike = Record<string, string | undefined>;

type StripePriceLike = {
  active?: boolean;
  currency?: string;
  unit_amount?: number | null;
  recurring?: {
    interval?: string | null;
  } | null;
};

type PriceResolution =
  | {
      ok: true;
      tier: CheckoutTier;
      priceId: string;
    }
  | {
      ok: false;
      tier: CheckoutTier | "unknown";
      status: 400 | 500;
      errorType: "unsupported_tier" | "price_not_configured";
      message: string;
    };

type PriceValidation =
  | { ok: true }
  | {
      ok: false;
      errorType: "price_inactive" | "price_mismatch";
      message: string;
    };

export function normalizeCheckoutTier(value: unknown): CheckoutTier | null {
  if (value === undefined || value === null || value === "") {
    return "premium";
  }

  if (value === "premium" || value === "api_access") {
    return value;
  }

  return null;
}

export function resolveCheckoutPriceId(
  value: unknown,
  env: EnvLike = process.env,
): PriceResolution {
  const tier = normalizeCheckoutTier(value);
  if (!tier) {
    return {
      ok: false,
      tier: "unknown",
      status: 400,
      errorType: "unsupported_tier",
      message: "Unsupported subscription tier",
    };
  }

  const plan = CHECKOUT_PLAN_CONFIG[tier];
  const priceId = firstConfiguredEnv(plan.priceEnvNames, env);
  if (!priceId) {
    return {
      ok: false,
      tier,
      status: 500,
      errorType: "price_not_configured",
      message: `${plan.displayName} pricing is not configured`,
    };
  }

  return { ok: true, tier, priceId };
}

export function getPremiumPriceId(env: EnvLike = process.env): string | null {
  return firstConfiguredEnv(CHECKOUT_PLAN_CONFIG.premium.priceEnvNames, env);
}

export function validateCheckoutPriceForTier(
  tier: CheckoutTier,
  price: StripePriceLike,
): PriceValidation {
  const plan = CHECKOUT_PLAN_CONFIG[tier];
  if (price.active === false) {
    return {
      ok: false,
      errorType: "price_inactive",
      message: `${plan.displayName} pricing is inactive`,
    };
  }

  const currency = price.currency?.toLowerCase();
  const interval = price.recurring?.interval ?? null;
  if (
    price.unit_amount !== plan.expectedUnitAmount ||
    currency !== plan.expectedCurrency ||
    interval !== plan.expectedInterval
  ) {
    return {
      ok: false,
      errorType: "price_mismatch",
      message: `${plan.displayName} pricing is misconfigured`,
    };
  }

  return { ok: true };
}

function firstConfiguredEnv(
  names: readonly string[],
  env: EnvLike,
): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return null;
}
