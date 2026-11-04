import {
  evidenceHeadline,
  formatRuleFigure,
  formatRuleMeasure,
  notEvaluatedCopy,
  pickFromStockFit,
  reasonText,
  shortDayLabel,
} from "~/@/lib/strategies/evidence";
import type { StockStrategyFit } from "~/app/actions/getStockStrategyFit";
import type { PickRow, RuleResultRow } from "~/@/lib/strategies/types";

const RULES = [
  { id: "short_crowding", title: "Short crowding", core: true, trigger: false },
  {
    id: "breakout",
    title: "Breakout on heavy volume",
    core: true,
    trigger: true,
  },
  {
    id: "liquidity",
    title: "Liquid enough to trade",
    core: true,
    trigger: false,
  },
  { id: "market", title: "Market direction", core: false, trigger: false },
];

function result(
  ruleId: string,
  status: RuleResultRow["status"],
  extra: Partial<RuleResultRow> = {},
): RuleResultRow {
  return { ruleId, status, detail: "", ...extra };
}

function pick(
  status: PickRow["status"],
  rules: RuleResultRow[],
  extra: Partial<PickRow> = {},
): Pick<PickRow, "status" | "rules" | "breakoutDate" | "asOf"> {
  return { status, rules, asOf: "2026-11-03", ...extra };
}

describe("evidenceHeadline", () => {
  it.each([
    [
      "triggered on the breakout session",
      pick("triggered", [], { breakoutDate: "2026-11-03" }),
      "Triggered on 3 Nov",
    ],
    [
      "triggered falls back to the session",
      pick("triggered", []),
      "Triggered on 3 Nov",
    ],
    [
      "setup names the failing trigger, lower case",
      pick("setup", [
        result("short_crowding", "pass"),
        result("breakout", "fail", { waiting: true }),
      ]),
      "Waiting for breakout on heavy volume",
    ],
    [
      "watch names the first failing core rule",
      pick("watch", [
        result("short_crowding", "fail"),
        result("liquidity", "fail"),
      ]),
      "Short crowding fails",
    ],
    [
      "watch ignores a failing scoring-only rule",
      pick("watch", [result("market", "fail"), result("liquidity", "fail")]),
      "Liquid enough to trade fails",
    ],
  ])("%s", (_name, input, expected) => {
    expect(evidenceHeadline(input, RULES)).toBe(expected);
  });

  it("names the rule that cannot be tested and its reason", () => {
    expect(
      evidenceHeadline(
        {
          status: "unknown" as PickRow["status"],
          rules: [result("breakout", "unknown", { reason: "no_volume" })],
          asOf: "",
        },
        RULES,
      ),
    ).toBe(
      "Breakout on heavy volume cannot be tested: Too few traded sessions to measure volume",
    );
  });
});

describe("reasonText", () => {
  it("maps the reason codes to their copy", () => {
    expect(reasonText("no_fundamentals")).toBe("No reported fundamentals");
    expect(reasonText("asic_report_stale")).toBe(
      "No ASIC report within 8 sessions",
    );
  });

  it("reads an unlisted code as a sentence, never as a raw id", () => {
    expect(reasonText("new_reason_code")).toBe("New reason code");
    expect(reasonText("")).toBe("");
    expect(reasonText(undefined)).toBe("");
  });
});

describe("formatRuleMeasure", () => {
  it("prints the value against the threshold in the rule's unit", () => {
    expect(
      formatRuleMeasure(
        { threshold: 5, unit: "pct", comparator: ">=" },
        { value: 10 },
      ),
    ).toBe("10.0% ≥ 5.0%");
  });

  it("prints liquidity in A$ with m and k", () => {
    expect(
      formatRuleMeasure(
        { threshold: 250_000, unit: "aud", comparator: ">=" },
        { value: 63_500_000 },
      ),
    ).toBe("A$63.5m ≥ A$250k");
  });

  it("is null without a value, a threshold or a known comparator", () => {
    expect(
      formatRuleMeasure(
        { threshold: 5, unit: "pct", comparator: ">=" },
        undefined,
      ),
    ).toBeNull();
    expect(
      formatRuleMeasure({ unit: "pct", comparator: ">=" }, { value: 1 }),
    ).toBeNull();
    expect(
      formatRuleMeasure(
        { threshold: 5, unit: "pct", comparator: "==" },
        { value: 1 },
      ),
    ).toBeNull();
  });

  it("keeps the unit's own sign on a point figure", () => {
    expect(formatRuleFigure(6.2, "pp")).toBe("+6.2pp");
    expect(formatRuleFigure(-1.5, "pp")).toBe("−1.5pp");
    expect(formatRuleFigure(4.84, "days")).toBe("4.8 days");
  });
});

describe("shortDayLabel", () => {
  it("drops the year and reads '' for a date that is not a day", () => {
    expect(shortDayLabel("2026-10-28")).toBe("28 Oct");
    expect(shortDayLabel("2026-02-31")).toBe("");
    expect(shortDayLabel(undefined)).toBe("");
  });
});

function fit(overrides: Partial<StockStrategyFit> = {}): StockStrategyFit {
  return {
    stockCode: "WTC",
    asOf: "2026-11-03",
    inUniverse: true,
    fits: [
      {
        strategyId: "crowded-short-breakout",
        strategyName: "Crowded-short breakout",
        status: "setup",
        score: 62,
        rank: 8,
        totalCount: 76,
        rules: [result("breakout", "fail", { waiting: true })],
        ruleColumns: [{ id: "breakout", title: "Breakout on heavy volume" }],
      },
    ],
    priceFeatures: {
      asOf: "2026-11-03",
      close: 40.81,
      sma50: null,
      sma150: null,
      sma200: null,
      sma200PriorMonth: null,
      high52w: null,
      low52w: null,
      baseHigh: 41.64,
      baseLow: null,
      baseDepthPct: null,
      baseLengthDays: null,
      breakoutRecent: false,
      breakoutDate: null,
      rs3mPct: 6.2,
      rs6mPct: null,
      volumeRatio50d: null,
      sessionsAvailable: 200,
    },
    regime: null,
    eligible: true,
    shortReportDate: "2026-10-28",
    shortAvailableDate: "2026-11-03",
    ...overrides,
  };
}

describe("pickFromStockFit", () => {
  it("builds the row a stock outside the list reads as", () => {
    const row = pickFromStockFit(fit(), "crowded-short-breakout");
    expect(row).toMatchObject({
      code: "WTC",
      status: "setup",
      score: 62,
      rank: 8,
      close: 40.81,
      pivot: 41.64,
      shortReportDate: "2026-10-28",
    });
    expect(row?.rules).toHaveLength(1);
  });

  it("is null when the strategy does not place the stock", () => {
    expect(pickFromStockFit(fit(), "canslim")).toBeNull();
    const none = fit({
      fits: [{ ...fit().fits[0]!, status: "none", score: null, rank: null }],
    });
    expect(pickFromStockFit(none, "crowded-short-breakout")).toBeNull();
  });
});

describe("notEvaluatedCopy", () => {
  it("states why a stock was not read on the session", () => {
    expect(
      notEvaluatedCopy({
        eligible: false,
        ineligibleReason: "short_history",
        sessionDate: "2026-11-03",
        asOf: "2026-11-03",
      }),
    ).toBe(
      "Not evaluated on 3 Nov: not enough trading history to read its signals.",
    );
  });

  it("is null for a stock that was read", () => {
    expect(notEvaluatedCopy({ eligible: true, asOf: "2026-11-03" })).toBeNull();
  });
});
