import { PAST_DUE_GRACE_MS, isEntitledSubscription } from "~/lib/subscription-entitlement";

const NOW = new Date("2026-10-23T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const periodEndDaysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

describe("isEntitledSubscription", () => {
  it("entitles active and trialing, whatever the period end", () => {
    expect(isEntitledSubscription({ status: "active", currentPeriodEnd: null, now: NOW })).toBe(true);
    expect(isEntitledSubscription({ status: "trialing", currentPeriodEnd: null, now: NOW })).toBe(true);
  });

  it("entitles past_due inside the 14 day grace", () => {
    expect(
      isEntitledSubscription({ status: "past_due", currentPeriodEnd: periodEndDaysAgo(13), now: NOW }),
    ).toBe(true);
    expect(
      isEntitledSubscription({ status: "past_due", currentPeriodEnd: periodEndDaysAgo(0), now: NOW }),
    ).toBe(true);
  });

  it("stops past_due once the 14 day grace has run out", () => {
    expect(
      isEntitledSubscription({ status: "past_due", currentPeriodEnd: periodEndDaysAgo(15), now: NOW }),
    ).toBe(false);
  });

  it("grants nothing to past_due without a period end, because the grace cannot be bounded", () => {
    expect(isEntitledSubscription({ status: "past_due", currentPeriodEnd: null, now: NOW })).toBe(false);
  });

  it.each(["unpaid", "canceled", "inactive", "incomplete", ""])(
    "grants nothing to %s, even with a period end in the future",
    (status) => {
      const future = new Date(NOW.getTime() + 30 * DAY);
      expect(isEntitledSubscription({ status, currentPeriodEnd: future, now: NOW })).toBe(false);
    },
  );

  it("uses a 14 day grace", () => {
    expect(PAST_DUE_GRACE_MS).toBe(14 * DAY);
  });
});
