/// <reference types="jest" />

import type { CompareRow, FundRow, PortfolioHolding } from "~/@/components/ownership/funds/fund-model";
import { changeInspectorContent, changeReading, type ChangeInspectorInput } from "../change-inspector";
import { fundInspectorContent, fundReading } from "../fund-inspector";
import {
  holdingInspectorContent,
  holdingReading,
  type HoldingInspectorInput,
  type HoldingSeriesPoint,
} from "../holding-inspector";

const FUND: FundRow = {
  key: "asx:A200",
  ticker: "VAS",
  name: "Vanguard Australian Shares Index Fund",
  institutionSlug: "vanguard",
  institutionName: "Vanguard",
  sourceKind: "etf",
  pooled: false,
  asAt: "2026-11-02",
  sourceUrl: "https://example.com/vas.csv",
  holdings: 198,
  top10Pct: 45,
  sectorWeights: [
    { industry: "Materials", weightPct: 10 },
    { industry: "Banks", weightPct: 25 },
    { industry: "", weightPct: 40 },
  ],
  largest: [],
  aumAud: null,
};

describe("fundReading (spec 14.1, backlog C1)", () => {
  it("names the file date and the largest sector's weight", () => {
    expect(fundReading(FUND)).toBe("VAS, 2026-11-02: Banks 25.00%.");
    expect(fundInspectorContent(FUND).reading).toBe("VAS, 2026-11-02: Banks 25.00%.");
  });

  it("falls back to the top ten's weight when the file gives no sectors", () => {
    expect(fundReading({ ...FUND, sectorWeights: [] })).toBe("VAS, 2026-11-02: the top 10 hold 45.00%.");
  });

  it("never leads with the Other tail, so the largest named sector is the reading", () => {
    const withOther = {
      ...FUND,
      sectorWeights: [
        { industry: "Other", weightPct: 40 },
        { industry: "Banks", weightPct: 25 },
      ],
    };
    expect(fundReading(withOther)).toBe("VAS, 2026-11-02: Banks 25.00%.");
    expect(fundReading({ ...FUND, sectorWeights: [{ industry: "Other", weightPct: 40 }] })).toBe(
      "VAS, 2026-11-02: the top 10 hold 45.00%.",
    );
  });

  it("drops the file date when it is not stated, and has no reading with no figure at all", () => {
    expect(fundReading({ ...FUND, asAt: "" })).toBe("VAS: Banks 25.00%.");
    expect(fundReading({ ...FUND, sectorWeights: [], top10Pct: null })).toBeUndefined();
    expect(fundInspectorContent({ ...FUND, sectorWeights: [], top10Pct: null }).reading).toBeUndefined();
  });
});

const HOLDING: PortfolioHolding = {
  code: "BHP",
  name: "BHP Group",
  industry: "Materials",
  weightPct: 8.4,
  units: 1000000,
  valueAud: null,
  sharesOnIssue: 2000000000,
  estCompanyPct: 0.05,
  sharesOnIssueAsAt: "2026-10-30",
};

function holdingInput(series: HoldingSeriesPoint[], overrides: Partial<PortfolioHolding> = {}): HoldingInspectorInput {
  return {
    fund: { ticker: "A200", name: "Betashares Australia 200 ETF", asAt: "2026-11-02", sourceUrl: "" },
    holding: { ...HOLDING, ...overrides },
    series,
  };
}

describe("holdingReading (spec 14.1, backlog C1)", () => {
  it("states the weight in the fund on the file date, and the change since the previous stated file", () => {
    expect(
      holdingReading(
        holdingInput([
          { asAt: "2026-09-30", weightPct: 8.1 },
          { asAt: "2026-11-02", weightPct: 8.4 },
        ]),
      ),
    ).toBe("BHP is 8.40% of A200 at 2026-11-02, +0.30 pp since 2026-09-30.");
  });

  it("prints the fall with the true minus", () => {
    expect(
      holdingReading(
        holdingInput([
          { asAt: "2026-09-30", weightPct: 8.5 },
          { asAt: "2026-11-02", weightPct: 8.4 },
        ]),
      ),
    ).toBe("BHP is 8.40% of A200 at 2026-11-02, −0.10 pp since 2026-09-30.");
  });

  it("leaves the change out with no earlier stated file, or when the latest stated file is not the one shown", () => {
    expect(holdingReading(holdingInput([{ asAt: "2026-11-02", weightPct: 8.4 }]))).toBe(
      "BHP is 8.40% of A200 at 2026-11-02.",
    );
    expect(
      holdingReading(
        holdingInput([
          { asAt: "2026-09-30", weightPct: 8.1 },
          { asAt: "2026-10-30", weightPct: 8.4 },
        ]),
      ),
    ).toBe("BHP is 8.40% of A200 at 2026-11-02.");
  });

  it("has no reading without the weight, the subject of the sentence", () => {
    expect(holdingReading(holdingInput([{ asAt: "2026-11-02", weightPct: null }], { weightPct: null }))).toBeUndefined();
  });

  it("is the reading the holding's content carries first", () => {
    const input = holdingInput([
      { asAt: "2026-09-30", weightPct: 8.1 },
      { asAt: "2026-11-02", weightPct: 8.4 },
    ]);
    expect(holdingInspectorContent(input).reading).toBe("BHP is 8.40% of A200 at 2026-11-02, +0.30 pp since 2026-09-30.");
    const unstated = holdingInput([{ asAt: "2026-11-02", weightPct: null }], { weightPct: null });
    expect(holdingInspectorContent(unstated).reading).toBeUndefined();
  });
});

const ROW: CompareRow = {
  code: "CBA",
  name: "Commonwealth Bank",
  industry: "Banks",
  weightFrom: 10.1,
  weightTo: 10.2,
  deltaPp: 0.1,
  valueFrom: null,
  valueTo: null,
  status: "continuing",
};

function changeInput(row: Partial<CompareRow>): ChangeInspectorInput {
  return {
    fund: { key: "asx:IOZ", ticker: "IOZ" },
    row: { ...ROW, ...row },
    from: "2026-09-30",
    to: "2026-11-02",
    sourceFrom: "",
    sourceTo: "",
  };
}

describe("changeReading (spec 14.1, backlog C1)", () => {
  it("states the two weights and the change in points", () => {
    expect(changeReading(changeInput({}))).toBe("CBA in IOZ: 10.10% to 10.20%, +0.10 pp.");
  });

  it("is the reading the change row's content carries first", () => {
    expect(changeInspectorContent(changeInput({})).reading).toBe("CBA in IOZ: 10.10% to 10.20%, +0.10 pp.");
    expect(changeInspectorContent(changeInput({ status: "dropped", weightTo: null, deltaPp: null })).reading).toBe(
      "CBA in IOZ, no longer reported.",
    );
  });

  it("adds the status of a row newly reported or no longer reported", () => {
    expect(changeReading(changeInput({ status: "new", weightFrom: null, deltaPp: null }))).toBe(
      "CBA in IOZ, newly reported.",
    );
    expect(changeReading(changeInput({ status: "dropped", weightTo: null, deltaPp: null }))).toBe(
      "CBA in IOZ, no longer reported.",
    );
    expect(changeReading(changeInput({ status: "new" }))).toBe("CBA in IOZ: 10.10% to 10.20%, +0.10 pp, newly reported.");
  });

  it("prints a fall with the true minus", () => {
    expect(changeReading(changeInput({ weightFrom: 10.2, weightTo: 10.1, deltaPp: -0.1 }))).toBe(
      "CBA in IOZ: 10.20% to 10.10%, −0.10 pp.",
    );
  });

  it("drops the weight pair when either weight is not stated, and has no reading with no figure or status", () => {
    expect(changeReading(changeInput({ weightTo: null }))).toBe("CBA in IOZ, +0.10 pp.");
    expect(changeReading(changeInput({ weightFrom: null, weightTo: null, deltaPp: null }))).toBeUndefined();
  });
});
