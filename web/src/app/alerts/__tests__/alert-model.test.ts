import { skippedDeliveryNotice } from "../alert-model";
import {
  buildMonitorSummary,
  conditionHelper,
  deliveryCopy,
  formatPoints,
  formatReportDate,
  formatThreshold,
  lastTriggeredCopy,
  movementCopy,
  rankCopy,
  thresholdUnit,
  type AlertEventCompanyView,
} from "../alert-model";

describe("buildMonitorSummary", () => {
  it("describes a stock threshold in percent", () => {
    expect(
      buildMonitorSummary({
        target: "BHP",
        condition: "short-interest-above",
        threshold: 5,
        cadence: "Daily",
      }),
    ).toBe("BHP - short interest above 5% - daily");
  });

  it("describes a rise in points, and the cadence lower case", () => {
    expect(
      buildMonitorSummary({
        target: "Materials",
        condition: "short-interest-rises",
        threshold: "1.5",
        cadence: "Weekly",
      }),
    ).toBe("Materials - short interest rises by 1.5 pts - weekly");
  });

  it("drops the threshold for a top-ten entry", () => {
    expect(
      buildMonitorSummary({
        target: "Health Care Equipment",
        condition: "new-top-ten-entry",
        threshold: null,
        cadence: "Daily",
      }),
    ).toBe("Health Care Equipment - new top-ten entry - daily");
  });

  it("says any company for an industry threshold, as the email summary does", () => {
    expect(
      buildMonitorSummary({
        target: "Materials",
        scope: "industry",
        condition: "short-interest-above",
        threshold: 5,
        cadence: "Daily",
      }),
    ).toBe("Materials - any company's short interest above 5% - daily");
    expect(
      buildMonitorSummary({
        target: "Materials",
        scope: "industry",
        condition: "short-interest-rises",
        threshold: "1.5",
        cadence: "Weekly",
      }),
    ).toBe(
      "Materials - any company's short interest rises by 1.5 pts - weekly",
    );
  });

  it("keeps the stock wording for a stock scope and the top-ten wording for industries", () => {
    expect(
      buildMonitorSummary({
        target: "BHP",
        scope: "stock",
        condition: "short-interest-above",
        threshold: 5,
        cadence: "Daily",
      }),
    ).toBe("BHP - short interest above 5% - daily");
    expect(
      buildMonitorSummary({
        target: "Materials",
        scope: "industry",
        condition: "new-top-ten-entry",
        threshold: null,
        cadence: "Daily",
      }),
    ).toBe("Materials - new top-ten entry - daily");
  });

  it("prints a half-typed threshold as typed", () => {
    expect(
      buildMonitorSummary({
        target: "BHP",
        condition: "short-interest-above",
        threshold: "",
        cadence: "Daily",
      }),
    ).toBe("BHP - short interest above % - daily");
  });
});

describe("conditionHelper", () => {
  it("keeps the stock wording for stock monitors", () => {
    expect(conditionHelper("stock", "short-interest-above")).toBe(
      "Notify when reported short interest crosses the threshold.",
    );
    expect(conditionHelper("stock", "short-interest-rises")).toBe(
      "Notify when the latest reported move is at least this many points.",
    );
  });

  it("says any company for industry monitors", () => {
    expect(conditionHelper("industry", "short-interest-above")).toBe(
      "Notify when any company in this industry crosses the threshold.",
    );
    expect(conditionHelper("industry", "short-interest-rises")).toBe(
      "Notify when any company in this industry's latest reported move is at least this many points.",
    );
  });

  it("describes the top-ten entry", () => {
    expect(conditionHelper("industry", "new-top-ten-entry")).toBe(
      "Notify when a company enters this industry's ten most-shorted companies.",
    );
  });
});

describe("threshold units", () => {
  it("uses points for rises and percent otherwise", () => {
    expect(thresholdUnit("short-interest-rises")).toBe("pts");
    expect(thresholdUnit("short-interest-above")).toBe("%");
    expect(thresholdUnit("new-top-ten-entry")).toBe("%");
    expect(formatThreshold(2, "short-interest-rises")).toBe("2 pts");
    expect(formatThreshold(2, "short-interest-above")).toBe("2%");
  });
});

describe("formatReportDate", () => {
  it("prints a calendar date without shifting it", () => {
    expect(formatReportDate("2026-10-16")).toBe("16 Oct 2026");
    expect(formatReportDate("2026-01-01")).toBe("1 Jan 2026");
  });

  it("returns an empty string for no date and the input for a non-date", () => {
    expect(formatReportDate(null)).toBe("");
    expect(formatReportDate("")).toBe("");
    expect(formatReportDate("16/10/2026")).toBe("16/10/2026");
  });
});

describe("formatPoints", () => {
  it("signs a change to two places", () => {
    expect(formatPoints(0.4)).toBe("+0.40");
    expect(formatPoints(-1.2)).toBe("-1.20");
    expect(formatPoints(0)).toBe("0.00");
  });

  it("never prints a negative zero", () => {
    expect(formatPoints(-0.001)).toBe("0.00");
  });
});

describe("deliveryCopy and lastTriggeredCopy", () => {
  it("names each delivery state", () => {
    expect(deliveryCopy("sent")).toBe("Emailed");
    expect(deliveryCopy("pending")).toBe("Queued");
    expect(deliveryCopy("failed")).toBe("Delivery failed");
    expect(deliveryCopy("skipped-unentitled")).toBe(
      "Not sent: Premium required",
    );
    expect(deliveryCopy("skipped-no-email")).toBe(
      "Not sent: no email on your account",
    );
    expect(deliveryCopy("skipped-paused")).toBe("Not sent: paused");
    expect(deliveryCopy(null)).toBe("Status unknown");
  });

  it("says never for a monitor that has not fired", () => {
    expect(
      lastTriggeredCopy({ lastEventReportDate: null, lastDeliveryState: null }),
    ).toBe("Last triggered: Never");
  });

  it("gives the report date and its delivery state", () => {
    expect(
      lastTriggeredCopy({
        lastEventReportDate: "2026-10-16",
        lastDeliveryState: "sent",
      }),
    ).toBe("Last triggered: 16 Oct 2026 report — Emailed");
  });
});

describe("company movement copy", () => {
  const base: AlertEventCompanyView = {
    productCode: "AAA",
    companyName: "Aaa Resources Ltd",
    latestPercent: 5.2,
    previousPercent: 4.8,
    changePoints: 0.4,
    rank: 0,
    previousRank: 0,
  };

  it("shows previous, latest and the signed change", () => {
    expect(movementCopy(base)).toBe("4.80% → 5.20% (+0.40 pts)");
  });

  it("says when there is no previous reading", () => {
    expect(
      movementCopy({ ...base, previousPercent: null, changePoints: null }),
    ).toBe("5.20% (no previous reading)");
  });

  it("describes a top-ten rank against the previous rank", () => {
    expect(rankCopy({ ...base, rank: 3, previousRank: 0 })).toBe(
      "Ranked #3 (was not ranked)",
    );
    expect(rankCopy({ ...base, rank: 3, previousRank: 7 })).toBe(
      "Ranked #3 (was #7)",
    );
  });

  it("omits the rank for an unranked company", () => {
    expect(rankCopy(base)).toBeNull();
  });
});

describe("skippedDeliveryNotice", () => {
  it("names the no-email skip as an unverified address, with a verify action", () => {
    const notice = skippedDeliveryNotice("skipped-no-email", {
      verified: false,
    });
    expect(notice).toMatchObject({
      label: "Not emailed: verify your email",
      needsVerification: true,
    });
  });

  it("drops the no-email skip once the address is verified, since the next alert is emailed", () => {
    expect(
      skippedDeliveryNotice("skipped-no-email", { verified: true }),
    ).toBeNull();
  });

  it("explains a skip for an inactive Premium subscription, without a verify action", () => {
    expect(
      skippedDeliveryNotice("skipped-unentitled", { verified: false }),
    ).toMatchObject({
      label: "Not emailed: no active Premium",
      needsVerification: false,
    });
  });

  it("explains a skip for a paused monitor", () => {
    expect(
      skippedDeliveryNotice("skipped-paused", { verified: true }),
    ).toMatchObject({
      label: "Not emailed: paused",
      needsVerification: false,
    });
  });

  it("shows nothing for a delivery that was sent, failed, pending or unknown", () => {
    for (const state of ["sent", "failed", "pending", null] as const) {
      expect(skippedDeliveryNotice(state, { verified: false })).toBeNull();
    }
  });
});
