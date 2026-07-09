import {
  resolveCheckoutPriceId,
  validateConfiguredCheckoutPrices,
  validateCheckoutPriceForTier,
} from "../stripe-plans";

describe("stripe checkout plan resolution", () => {
  it("defaults missing tier to the Premium price", () => {
    expect(
      resolveCheckoutPriceId(undefined, {
        STRIPE_PRO_PRICE_ID: " price_premium ",
      })
    ).toEqual({
      ok: true,
      tier: "premium",
      priceId: "price_premium",
    });
  });

  it("keeps the legacy Premium env fallback for Premium only", () => {
    expect(
      resolveCheckoutPriceId("premium", {
        STRIPE_PREMIUM_PRICE_ID: "price_legacy_premium",
      })
    ).toEqual({
      ok: true,
      tier: "premium",
      priceId: "price_legacy_premium",
    });
  });

  it("resolves API Access only from the dedicated API price env var", () => {
    expect(
      resolveCheckoutPriceId("api_access", {
        STRIPE_PRO_PRICE_ID: "price_premium",
        STRIPE_PREMIUM_PRICE_ID: "price_legacy_premium",
      })
    ).toEqual({
      ok: false,
      tier: "api_access",
      status: 500,
      errorType: "price_not_configured",
      message: "API Access pricing is not configured",
    });
  });

  it("rejects unsupported tiers", () => {
    expect(resolveCheckoutPriceId("enterprise_api", {})).toEqual({
      ok: false,
      tier: "unknown",
      status: 400,
      errorType: "unsupported_tier",
      message: "Unsupported subscription tier",
    });
  });

  it("accepts the expected Premium Stripe price shape", () => {
    expect(
      validateCheckoutPriceForTier("premium", {
        active: true,
        unit_amount: 400,
        currency: "AUD",
        recurring: { interval: "month" },
      })
    ).toEqual({ ok: true });
  });

  it("rejects a Premium price that points at the API Access amount", () => {
    expect(
      validateCheckoutPriceForTier("premium", {
        active: true,
        unit_amount: 2000,
        currency: "aud",
        recurring: { interval: "month" },
      })
    ).toEqual({
      ok: false,
      errorType: "price_mismatch",
      message: "Premium pricing is misconfigured",
    });
  });

  it("preflights the configured Premium Stripe price before release", async () => {
    const retrievePrice = jest.fn().mockResolvedValue({
      active: true,
      unit_amount: 400,
      currency: "aud",
      recurring: { interval: "month" },
    });

    await expect(
      validateConfiguredCheckoutPrices({
        env: { STRIPE_PRO_PRICE_ID: "price_premium" },
        retrievePrice,
      })
    ).resolves.toEqual([
      {
        ok: true,
        tier: "premium",
        priceId: "price_premium",
        envName: "STRIPE_PRO_PRICE_ID",
      },
      {
        ok: true,
        tier: "api_access",
        skipped: true,
        reason: "price_not_configured",
      },
    ]);
    expect(retrievePrice).toHaveBeenCalledWith("price_premium");
  });

  it("reports a misconfigured Premium Stripe price during preflight", async () => {
    const retrievePrice = jest.fn().mockResolvedValue({
      active: true,
      unit_amount: 2000,
      currency: "aud",
      recurring: { interval: "month" },
    });

    await expect(
      validateConfiguredCheckoutPrices({
        env: { STRIPE_PRO_PRICE_ID: "price_premium" },
        retrievePrice,
      })
    ).resolves.toEqual([
      {
        ok: false,
        tier: "premium",
        priceId: "price_premium",
        envName: "STRIPE_PRO_PRICE_ID",
        errorType: "price_mismatch",
        message: "Premium pricing is misconfigured",
      },
      {
        ok: true,
        tier: "api_access",
        skipped: true,
        reason: "price_not_configured",
      },
    ]);
  });

  it("fails preflight when the required Premium price is missing", async () => {
    await expect(
      validateConfiguredCheckoutPrices({
        env: {},
        retrievePrice: jest.fn(),
      })
    ).resolves.toContainEqual({
      ok: false,
      tier: "premium",
      errorType: "price_not_configured",
      message: "Premium pricing is not configured",
    });
  });
});
