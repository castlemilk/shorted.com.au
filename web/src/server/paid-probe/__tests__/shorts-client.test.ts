/** @jest-environment node */
import { SubscriptionStatus, SubscriptionTier } from "~/gen/shorts/v1alpha1/billing_pb";

import { toSubscriptionInfo } from "../shorts-client";
import { hasValidChatEntitlement } from "@/lib/chat-server-guards";

jest.mock("~/server/auth", () => ({ auth: jest.fn() }));
jest.mock("~/app/actions/subscription", () => ({ getSubscriptionStatus: jest.fn() }));
jest.mock("@/lib/rate-limit", () => ({ rateLimit: jest.fn() }));

describe("toSubscriptionInfo", () => {
  it("maps an internal enterprise grant to an entitlement the chat guard accepts", () => {
    const info = toSubscriptionInfo({
      hasSubscription: true,
      status: SubscriptionStatus.ACTIVE,
      tier: SubscriptionTier.ENTERPRISE,
      currentPeriodEnd: undefined,
      cancelAtPeriodEnd: false,
    });
    expect(info).toMatchObject({ status: "active", tier: "enterprise", hasActiveSubscription: true, isPremium: true });
    expect(hasValidChatEntitlement(info)).toBe(true);
  });

  it("treats no subscription as free, which the chat guard refuses", () => {
    const info = toSubscriptionInfo({
      hasSubscription: false,
      status: SubscriptionStatus.UNSPECIFIED,
      tier: SubscriptionTier.UNSPECIFIED,
    });
    expect(info).toMatchObject({ status: "inactive", tier: "free", isPremium: false });
    expect(hasValidChatEntitlement(info)).toBe(false);
  });

  it("refuses a canceled subscription even on a paid tier", () => {
    const info = toSubscriptionInfo({
      hasSubscription: true,
      status: SubscriptionStatus.CANCELED,
      tier: SubscriptionTier.PRO,
    });
    expect(hasValidChatEntitlement(info)).toBe(false);
  });

  it("reads the period end the way subscription.ts does, from seconds and nanos", () => {
    const info = toSubscriptionInfo({
      hasSubscription: true,
      status: SubscriptionStatus.TRIALING,
      tier: SubscriptionTier.PREMIUM,
      currentPeriodEnd: { seconds: BigInt(1_800_000_000), nanos: 250_000_000 },
    });
    expect(info.currentPeriodEnd?.getTime()).toBe(1_800_000_000_250);
    expect(info.status).toBe("trialing");
  });
});
