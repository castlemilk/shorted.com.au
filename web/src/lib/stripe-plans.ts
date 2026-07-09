export const CHECKOUT_PLAN_CONFIG = {
  premium: {
    displayName: "Premium",
    priceEnvNames: ["STRIPE_PRO_PRICE_ID", "STRIPE_PREMIUM_PRICE_ID"],
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

type PriceValidationErrorType = "price_inactive" | "price_mismatch";

type PriceValidation =
  | { ok: true }
  | {
      ok: false;
      errorType: PriceValidationErrorType;
      message: string;
    };

export type CheckoutPricePreflightResult =
  | {
      ok: true;
      tier: CheckoutTier;
      priceId: string;
      envName: string;
    }
  | {
      ok: true;
      tier: CheckoutTier;
      skipped: true;
      reason: "price_not_configured";
    }
  | {
      ok: false;
      tier: CheckoutTier;
      priceId?: string;
      envName?: string;
      errorType:
        | "price_not_configured"
        | "price_retrieve_failed"
        | PriceValidationErrorType;
      message: string;
    };

type ConfiguredPriceValidationOptions = {
  env?: EnvLike;
  retrievePrice: (priceId: string) => Promise<StripePriceLike>;
  tiers?: readonly CheckoutTier[];
  requiredTiers?: readonly CheckoutTier[];
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

export async function validateConfiguredCheckoutPrices({
  env = process.env,
  retrievePrice,
  tiers = ["premium", "api_access"],
  requiredTiers = ["premium"],
}: ConfiguredPriceValidationOptions): Promise<CheckoutPricePreflightResult[]> {
  const required = new Set<CheckoutTier>(requiredTiers);
  const results: CheckoutPricePreflightResult[] = [];

  for (const tier of tiers) {
    const plan = CHECKOUT_PLAN_CONFIG[tier];
    const configured = firstConfiguredEnvEntry(plan.priceEnvNames, env);
    if (!configured) {
      if (required.has(tier)) {
        results.push({
          ok: false,
          tier,
          errorType: "price_not_configured",
          message: `${plan.displayName} pricing is not configured`,
        });
      } else {
        results.push({
          ok: true,
          tier,
          skipped: true,
          reason: "price_not_configured",
        });
      }
      continue;
    }

    const { name: envName, value: priceId } = configured;
    let stripePrice: StripePriceLike;
    try {
      stripePrice = await retrievePrice(priceId);
    } catch (error) {
      results.push({
        ok: false,
        tier,
        priceId,
        envName,
        errorType: "price_retrieve_failed",
        message:
          error instanceof Error
            ? error.message
            : `Could not retrieve ${plan.displayName} Stripe price`,
      });
      continue;
    }

    const validation = validateCheckoutPriceForTier(tier, stripePrice);
    if (!validation.ok) {
      results.push({
        ok: false,
        tier,
        priceId,
        envName,
        errorType: validation.errorType,
        message: validation.message,
      });
      continue;
    }

    results.push({
      ok: true,
      tier,
      priceId,
      envName,
    });
  }

  return results;
}

function firstConfiguredEnv(
  names: readonly string[],
  env: EnvLike,
): string | null {
  return firstConfiguredEnvEntry(names, env)?.value ?? null;
}

function firstConfiguredEnvEntry(
  names: readonly string[],
  env: EnvLike,
): { name: string; value: string } | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return { name, value };
    }
  }

  return null;
}
