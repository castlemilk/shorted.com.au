import { PAST_DUE_GRACE_MS, isEntitledSubscription } from "~/lib/subscription-entitlement";

const NOW = new Date("2026-10-23T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const failedDaysAgo = (days: number) => new Date(NOW.getTime() - days * DAY);

describe("isEntitledSubscription", () => {
  it("entitles active and trialing, whatever the failure time", () => {
    expect(isEntitledSubscription({ status: "active", pastDueSince: null, now: NOW })).toBe(true);
    expect(isEntitledSubscription({ status: "trialing", pastDueSince: null, now: NOW })).toBe(true);
  });

  it("entitles past_due inside 14 days of the first failed charge", () => {
    expect(isEntitledSubscription({ status: "past_due", pastDueSince: failedDaysAgo(13), now: NOW })).toBe(true);
    expect(isEntitledSubscription({ status: "past_due", pastDueSince: failedDaysAgo(0), now: NOW })).toBe(true);
  });

  it("ends past_due 14 days after the first failed charge", () => {
    expect(isEntitledSubscription({ status: "past_due", pastDueSince: failedDaysAgo(15), now: NOW })).toBe(false);
  });

  it("does not let a future period end extend the grace", () => {
    // The period end is not an input at all: a card failing for months still ends
    // at 14 days after the first failure.
    expect(isEntitledSubscription({ status: "past_due", pastDueSince: failedDaysAgo(50), now: NOW })).toBe(false);
  });

  it("grants nothing to past_due with no failure time, because the grace cannot be bounded", () => {
    expect(isEntitledSubscription({ status: "past_due", pastDueSince: null, now: NOW })).toBe(false);
  });

  it.each(["unpaid", "canceled", "inactive", "incomplete", ""])(
    "grants nothing to %s, even with a recent failure time",
    (status) => {
      expect(isEntitledSubscription({ status, pastDueSince: failedDaysAgo(1), now: NOW })).toBe(false);
    },
  );

  it("uses a 14 day grace", () => {
    expect(PAST_DUE_GRACE_MS).toBe(14 * DAY);
  });
});
