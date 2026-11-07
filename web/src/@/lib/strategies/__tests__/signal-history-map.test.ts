import {
  mapSignalEventsResponse,
  mapStrategyDataStatus,
  mapStrategySignalEvent,
} from "~/@/lib/strategies/map";

describe("mapStrategyDataStatus", () => {
  it("maps the sessions, the snapshot and every ASIC report with its availability", () => {
    const status = mapStrategyDataStatus({
      latestSession: "2026-11-04",
      pricesCompletedAt: "2026-11-04T06:12:00Z",
      snapshotAsOf: "2026-11-04",
      snapshotCompletedAt: "2026-11-04T06:40:00Z",
      nextUpdateUtc: "2026-11-05T03:00:00Z",
      pricedCodes: 2100,
      asicReports: [
        {
          reportDate: "2026-10-28",
          availableDate: "2026-11-03",
          firstIngestedAt: "2026-10-28T01:30:00Z",
          rows: 1812,
          complete: true,
        },
      ],
    });
    expect(status.latestSession).toBe("2026-11-04");
    expect(status.pricesCompletedAt).toBe("2026-11-04");
    expect(status.snapshotAsOf).toBe("2026-11-04");
    expect(status.pricedCodes).toBe(2100);
    expect(status.asicReports).toEqual([
      {
        reportDate: "2026-10-28",
        availableDate: "2026-11-03",
        firstIngestedAt: "2026-10-28",
        rows: 1812,
        complete: true,
      },
    ]);
  });

  it("reads absent fields as empty, never as a date or a count", () => {
    const status = mapStrategyDataStatus({
      asicReports: [{ reportDate: "2026-10-28" }],
    });
    expect(status.latestSession).toBe("");
    expect(status.snapshotCompletedAt).toBe("");
    expect(status.pricedCodes).toBe(0);
    expect(status.asicReports[0]).toEqual({
      reportDate: "2026-10-28",
      availableDate: "",
      firstIngestedAt: "",
      rows: 0,
      complete: false,
    });
  });
});

describe("mapStrategySignalEvent", () => {
  it("keeps each rule's status and value, and a pivot only when its flag is set", () => {
    const event = mapStrategySignalEvent({
      stockCode: "PFP",
      companyName: "Perpetual Flour",
      sessionDate: "2026-11-03",
      prevSessionDate: "2026-10-30",
      fromStatus: "setup",
      toStatus: "triggered",
      score: 71.5,
      close: 41.2,
      pivot: 41.64,
      hasPivot: true,
      rulesHash: "3f9a1c2e" + "b".repeat(56),
      rules: [
        {
          ruleId: "near_high",
          status: "pass",
          detail: "Within 10%",
          value: 9.5,
          hasValue: true,
        },
        { ruleId: "growth", status: "unknown", reason: "no_fundamentals" },
      ],
    });
    expect(event.toStatus).toBe("triggered");
    expect(event.pivot).toBe(41.64);
    expect(event.rules).toEqual([
      { ruleId: "near_high", status: "pass", detail: "Within 10%", value: 9.5 },
      {
        ruleId: "growth",
        status: "unknown",
        detail: "",
        reason: "no_fundamentals",
      },
    ]);
  });

  it("drops a pivot the flag does not vouch for", () => {
    const event = mapStrategySignalEvent({
      stockCode: "PFP",
      sessionDate: "2026-11-03",
      toStatus: "watch",
      pivot: 41.64,
      hasPivot: false,
    });
    expect(event.pivot).toBeUndefined();
    expect(event.rules).toEqual([]);
  });
});

describe("mapSignalEventsResponse", () => {
  it("returns the page, its token and the version it belongs to", () => {
    const page = mapSignalEventsResponse({
      events: [
        { stockCode: "BHP", sessionDate: "2026-11-02", toStatus: "setup" },
      ],
      nextPageToken: "41",
      version: {
        strategyId: "canslim",
        label: "v1",
        rulesHash: "3f9a1c2e" + "0".repeat(56),
      },
    });
    expect(page.events.map((event) => event.stockCode)).toEqual(["BHP"]);
    expect(page.nextPageToken).toBe("41");
    expect(page.version?.label).toBe("v1");
  });

  it("is an empty last page with no version when the response carries neither", () => {
    expect(mapSignalEventsResponse({})).toEqual({
      events: [],
      nextPageToken: "",
      version: null,
    });
  });
});
