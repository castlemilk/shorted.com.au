import { canMintApiTokensForTier, isPremiumTier } from "~/lib/stripe";

/**
 * Premium features (AI chat, alerts, dashboards) belong to the premium tiers. API
 * Access is a paid API tier, and it carries none of them. A tier that lets API Access
 * through here hands it the premium features.
 */
describe("isPremiumTier", () => {
  it.each(["premium", "pro", "enterprise"] as const)("admits %s, which carries the premium features", (tier) => {
    expect(isPremiumTier(tier)).toBe(true);
  });

  it("refuses api_access, which is a paid API tier and not a premium one", () => {
    expect(isPremiumTier("api_access")).toBe(false);
  });

  it("refuses the free tier", () => {
    expect(isPremiumTier("free")).toBe(false);
  });
});

describe("canMintApiTokensForTier", () => {
  // Premium is sold token creation ("Premium subscribers can create tokens", /docs/api),
  // so it may mint. Its tokens get the free API limits, which is a rate-limit fact and
  // not a token fact.
  it.each(["premium", "pro", "enterprise", "api_access"] as const)("lets %s mint tokens", (tier) => {
    expect(canMintApiTokensForTier(tier)).toBe(true);
  });

  it("refuses the free tier, which is not a paid plan", () => {
    expect(canMintApiTokensForTier("free")).toBe(false);
  });
});
