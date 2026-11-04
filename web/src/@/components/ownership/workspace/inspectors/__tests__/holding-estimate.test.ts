/// <reference types="jest" />

import { holdingInspectorContent } from "../holding-inspector";
import type { PortfolioHolding } from "../../../funds/fund-model";

function holding(overrides: Partial<PortfolioHolding> = {}): PortfolioHolding {
  return {
    code: "BHP",
    name: "BHP Group",
    industry: "Materials",
    weightPct: 8.4,
    units: 25_400_000,
    valueAud: 1_000_000,
    sharesOnIssue: 5_000_000_000,
    estCompanyPct: 0.5,
    sharesOnIssueAsAt: "2026-10-31",
    ...overrides,
  };
}

const FUND = { ticker: "A200", name: "A200 fund", asAt: "2026-10-31", sourceUrl: "" };

function row(content: ReturnType<typeof holdingInspectorContent>, label: string): string | undefined {
  return content.rows.find((candidate) => candidate.label === label)?.value;
}

describe("the holding inspector's estimate (spec 14.3, Fund page)", () => {
  it("prints the estimate when units and shares on issue are both stated", () => {
    const content = holdingInspectorContent({ fund: FUND, holding: holding(), series: [] });
    expect(row(content, "Est. company shares held")).toBe("0.50%");
  });

  it("reads n/a when the shares on issue are missing, whatever estimate the API sent", () => {
    const content = holdingInspectorContent({
      fund: FUND,
      holding: holding({ sharesOnIssue: null, estCompanyPct: 0.5 }),
      series: [],
    });
    expect(row(content, "Est. company shares held")).toBe("n/a");
  });

  it("names the holdings and the shares-on-issue basis as the wireframe does", () => {
    const content = holdingInspectorContent({ fund: FUND, holding: holding(), series: [] });
    expect(row(content, "Holdings")).toBe("2026-10-31");
    expect(row(content, "Shares-on-issue basis")).toBe("2026-10-31");
  });
});
