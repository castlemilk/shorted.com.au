/**
 * Chat trusts the API's answer. The API applies one entitlement rule, including
 * the grace after a period ends, and reports a lapsed subscription as inactive.
 * Re-checking the period here denied paying customers at every renewal boundary,
 * so these tests pin that the clock does not decide.
 */
import { hasValidChatEntitlement } from "../chat-server-guards";
import type { SubscriptionInfo } from "~/app/actions/subscription";

function paid(overrides: Partial<SubscriptionInfo> = {}): SubscriptionInfo {
  return {
    status: "active",
    tier: "premium",
    hasActiveSubscription: true,
    isPremium: true,
    canMintTokens: true,
    currentPeriodEnd: null,
    pastDueSince: null,
    cancelAtPeriodEnd: false,
    features: [],
    requestsPerDay: 10000,
    ...overrides,
  };
}

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000);

describe("hasValidChatEntitlement", () => {
  it("accepts an active premium answer", () => {
    expect(hasValidChatEntitlement(paid())).toBe(true);
  });

  it("accepts a premium customer whose card failed inside the 14 day grace", () => {
    // The customer's banner says access continues while Stripe retries, so chat must
    // not refuse them: the guard is what made the banner's promise false.
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(
      hasValidChatEntitlement(paid({ status: "past_due", pastDueSince: twoDaysAgo })),
    ).toBe(true);
  });

  it("refuses a premium customer whose card failed more than 14 days ago, even if a stale answer says premium", () => {
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    expect(
      hasValidChatEntitlement(paid({ status: "past_due", pastDueSince: twentyDaysAgo })),
    ).toBe(false);
  });

  it("refuses a past_due premium customer with no failure time", () => {
    expect(hasValidChatEntitlement(paid({ status: "past_due", pastDueSince: null }))).toBe(false);
  });

  it("refuses unpaid, whatever its failure time", () => {
    expect(
      hasValidChatEntitlement(paid({ status: "unpaid", pastDueSince: YESTERDAY })),
    ).toBe(false);
  });

  it("accepts a trialing answer", () => {
    expect(hasValidChatEntitlement(paid({ status: "trialing" }))).toBe(true);
  });

  it("trusts the API when the period end is in the past, as the rest of the product does", () => {
    // The API keeps a lapsed period active for its grace window and reports the
    // result. A period end in the past is therefore not a denial here.
    expect(hasValidChatEntitlement(paid({ currentPeriodEnd: YESTERDAY }))).toBe(true);
  });

  it("accepts pro and enterprise tiers, which the API still reports for legacy plans", () => {
    expect(hasValidChatEntitlement(paid({ tier: "pro" }))).toBe(true);
    expect(hasValidChatEntitlement(paid({ tier: "enterprise" }))).toBe(true);
  });

  it.each(["past_due", "inactive", "canceled"] as const)(
    "refuses a %s status, whatever the period",
    (status) => {
      expect(
        hasValidChatEntitlement(
          paid({ status, hasActiveSubscription: false, isPremium: false }),
        ),
      ).toBe(false);
    },
  );

  it("refuses a free tier", () => {
    expect(hasValidChatEntitlement(paid({ tier: "free" }))).toBe(false);
  });

  it("refuses when the API says there is no active subscription, even with a live status", () => {
    expect(hasValidChatEntitlement(paid({ hasActiveSubscription: false }))).toBe(false);
  });

  it("refuses when the API says the user is not premium", () => {
    expect(hasValidChatEntitlement(paid({ isPremium: false }))).toBe(false);
  });

  it("refuses a missing answer", () => {
    expect(hasValidChatEntitlement(null)).toBe(false);
    expect(hasValidChatEntitlement(undefined)).toBe(false);
  });
});
