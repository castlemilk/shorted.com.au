/// <reference types="jest" />

/**
 * The funds' loaders and inspector resolvers (app/actions/ownershipFunds.ts):
 *
 *   - AN OUTAGE IS NOT A MISSING FUND. A portfolio the record does not hold is
 *     `missing` (the page's 404); a transient failure is ok: false and is never a 404.
 *   - A QUERY THE LOADER CANNOT SEND MAKES NO REQUEST: a fund key outside the shape,
 *     an inverted pair of dates, a selection that is not an object.
 *   - THE ROWS ARE PLAIN. A figure the API did not state (its has_ flag false) is
 *     null, never zero; a file's dates come back oldest first.
 *   - A RESOLVER NEVER THROWS. An outage is a note on the content; null only names a
 *     selection that is not on record.
 */

const mockListFunds = jest.fn();
const mockGetFundPortfolio = jest.fn();
const mockCompareFundSnapshots = jest.fn();

jest.mock("../ownership-shared", () => ({
  ownershipClient: () => ({
    listFunds: (request: unknown) => mockListFunds(request),
    getFundPortfolio: (request: unknown) => mockGetFundPortfolio(request),
    compareFundSnapshots: (request: unknown) => mockCompareFundSnapshots(request),
  }),
}));

// The wrappers the desk uses, reduced to what they promise: NotFound throws its own
// class for the portfolio, everything else is undefined.
jest.mock("../withRetry", () => {
  class NotFoundError extends Error {
    constructor(message = "Resource not found") {
      super(message);
      this.name = "NotFoundError";
    }
  }
  return {
    NotFoundError,
    withRetryAndNotFound: (fn: (...args: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch {
        return undefined;
      }
    },
    withRetryAndThrowNotFound: (fn: (...args: unknown[]) => Promise<unknown>) => async (...args: unknown[]) => {
      try {
        return await fn(...args);
      } catch (error) {
        if ((error as { notFound?: boolean }).notFound) throw new NotFoundError();
        return undefined;
      }
    },
  };
});

import {
  compareFundSnapshots,
  loadFundPortfolio,
  loadFunds,
  resolveChangeSelection,
  resolveFundSelection,
} from "../ownershipFunds";
import type { Selection } from "~/@/components/ownership/workspace/selection";

// The selections are built here, not parsed: the codec reads a key without its colon,
// and the fixtures carry the API's keys (asx:CODE, slug/name) as ListFunds issues them.
const fundSel = (fundKey: string): Selection => ({ kind: "fund", fundKey });
const holdingSel = (fundKey: string, code: string): Selection => ({ kind: "holding", fundKey, code });

let warn: jest.SpyInstance;

function summary(overrides: Record<string, unknown> = {}) {
  return {
    fundKey: "asx:A200",
    ticker: "A200",
    name: "BetaShares Australia 200 ETF",
    institutionSlug: "betashares",
    institutionName: "Betashares",
    sourceKind: "etf",
    pooled: false,
    asAt: "2026-10-31",
    sourceUrl: "https://example.com/a200.csv",
    holdings: 198,
    top10Pct: 44.2,
    hasTop10Pct: true,
    sectorWeights: [{ industry: "Banks", weightPct: 30, hasWeightPct: true }],
    largest: [{ code: "CBA", name: "Commonwealth Bank", weightPct: 9.1, hasWeightPct: true }],
    aumAud: 0,
    hasAumAud: false,
    ...overrides,
  };
}

function holding(code: string, overrides: Record<string, unknown> = {}) {
  return {
    code,
    name: `${code} Ltd`,
    industry: "Materials",
    weightPct: 8.4,
    hasWeightPct: true,
    units: 25_400_000,
    hasUnits: true,
    valueAud: 0,
    hasValueAud: false,
    sharesOnIssue: 0,
    hasSharesOnIssue: false,
    estCompanyPct: 0,
    hasEstCompanyPct: false,
    sharesOnIssueAsAt: "",
    ...overrides,
  };
}

function portfolio(asAt: string, holdings: unknown[] = [holding("BHP")]) {
  return {
    fundKey: "asx:A200",
    ticker: "A200",
    name: "BetaShares Australia 200 ETF",
    institutionSlug: "betashares",
    institutionName: "Betashares",
    sourceKind: "etf",
    pooled: false,
    asAt,
    sourceUrl: "https://example.com/a200.csv",
    snapshotDates: ["2026-10-31", "2026-09-30"],
    holdings,
    holdingsTotal: holdings.length,
    top10Pct: 44.2,
    hasTop10Pct: true,
    sectorWeights: [],
  };
}

function change(code: string, overrides: Record<string, unknown> = {}) {
  return {
    code,
    name: `${code} Ltd`,
    industry: "Banks",
    weightFromPct: 10.1,
    hasWeightFromPct: true,
    weightToPct: 10.2,
    hasWeightToPct: true,
    deltaPp: 0.1,
    hasDeltaPp: true,
    valueFromAud: 0,
    hasValueFromAud: false,
    valueToAud: 0,
    hasValueToAud: false,
    status: "continuing",
    ...overrides,
  };
}

beforeEach(() => {
  mockListFunds.mockReset();
  mockGetFundPortfolio.mockReset();
  mockCompareFundSnapshots.mockReset();
  warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe("loadFunds", () => {
  it("maps every fund to plain rows, a figure not stated becoming null", async () => {
    mockListFunds.mockResolvedValue({ funds: [summary({ hasTop10Pct: false })] });
    const page = await loadFunds();
    expect(page.ok).toBe(true);
    expect(page.funds[0]).toMatchObject({
      key: "asx:A200",
      top10Pct: null,
      aumAud: null,
      sectorWeights: [{ industry: "Banks", weightPct: 30 }],
      largest: [{ code: "CBA", name: "Commonwealth Bank", weightPct: 9.1 }],
    });
  });

  it("reads the largest sector change with its has_ flag, and withholds both figures without it", async () => {
    mockListFunds.mockResolvedValue({
      funds: [
        summary({ largestSectorChangePp: -2.5, hasLargestSectorChange: true, largestSectorChangeSector: "Banks" }),
        summary({ fundKey: "asx:IOZ", ticker: "IOZ", largestSectorChangePp: 0, hasLargestSectorChange: false, largestSectorChangeSector: "" }),
      ],
    });
    const page = await loadFunds();
    expect(page.funds[0]).toMatchObject({ largestSectorChangePp: -2.5, largestSectorChangeSector: "Banks" });
    expect(page.funds[1]).toMatchObject({ largestSectorChangePp: null, largestSectorChangeSector: "" });
  });

  it("answers an outage as not ok, never as an empty fund list", async () => {
    mockListFunds.mockRejectedValue({ code: 14, message: "unavailable" });
    const page = await loadFunds();
    expect(page).toEqual({ ok: false, error: "", funds: [] });
  });
});

describe("loadFundPortfolio", () => {
  it("makes no request for a key outside the shape, and says why", async () => {
    const page = await loadFundPortfolio({ fundKey: "A/200" });
    expect(page.ok).toBe(false);
    expect(page.missing).toBe(false);
    expect(page.error).toContain("the fund key");
    expect(mockGetFundPortfolio).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("reports a fund the record does not hold as missing, which is the page's 404", async () => {
    mockGetFundPortfolio.mockRejectedValue(Object.assign(new Error("not found"), { notFound: true }));
    const page = await loadFundPortfolio({ fundKey: "asx:NOPE" });
    expect(page).toEqual({ ok: false, missing: true, error: "", fund: null });
  });

  it("reports a transient failure as an outage, never as missing", async () => {
    mockGetFundPortfolio.mockRejectedValue(new Error("connection reset"));
    const page = await loadFundPortfolio({ fundKey: "asx:A200" });
    expect(page.ok).toBe(false);
    expect(page.missing).toBe(false);
  });

  it("maps the holdings with their nulls, and lists the file dates oldest first", async () => {
    mockGetFundPortfolio.mockResolvedValue(
      portfolio("2026-10-31", [holding("BHP"), holding("NOW", { hasWeightPct: false, weightPct: 0 })]),
    );
    const page = await loadFundPortfolio({ fundKey: "asx:A200" });
    expect(page.ok).toBe(true);
    expect(page.fund?.snapshotDates).toEqual(["2026-09-30", "2026-10-31"]);
    expect(page.fund?.holdings[0]).toMatchObject({ code: "BHP", weightPct: 8.4, units: 25_400_000, estCompanyPct: null });
    expect(page.fund?.holdings[1]?.weightPct).toBeNull();
  });
});

describe("compareFundSnapshots", () => {
  it("refuses an inverted pair of dates without asking the API", async () => {
    const page = await compareFundSnapshots({ fundKey: "asx:A200", from: "2026-10-31", to: "2026-09-30" });
    expect(page.ok).toBe(false);
    expect(page.error).toBe("from is after to");
    expect(mockCompareFundSnapshots).not.toHaveBeenCalled();
  });

  it("maps the rows with a status and a change only where both files state it", async () => {
    mockCompareFundSnapshots.mockResolvedValue({
      from: "2026-09-30",
      to: "2026-10-31",
      sourceFrom: "https://example.com/a.csv",
      sourceTo: "https://example.com/b.csv",
      rows: [change("CBA"), change("NEW", { status: "new", hasDeltaPp: false, hasWeightFromPct: false })],
      snapshotDates: [],
    });
    const page = await compareFundSnapshots({ fundKey: "asx:A200", from: "2026-09-30", to: "2026-10-31" });
    expect(page.ok).toBe(true);
    expect(page.rows[0]).toMatchObject({ code: "CBA", deltaPp: 0.1, weightFrom: 10.1, status: "continuing" });
    expect(page.rows[1]).toMatchObject({ code: "NEW", deltaPp: null, weightFrom: null, status: "new" });
    expect(page.sourceTo).toBe("https://example.com/b.csv");
  });
});

describe("the inspector resolvers", () => {
  it("resolves a fund to its content, and a fund the record does not hold to nothing", async () => {
    mockListFunds.mockResolvedValue({ funds: [summary()] });
    const content = await resolveFundSelection(fundSel("asx:A200"));
    expect(content?.heading).toBe("A200");
    expect(await resolveFundSelection(fundSel("asx:ZZZ"))).toBeNull();
  });

  it("resolves a holding with its weight across the recent file dates", async () => {
    mockGetFundPortfolio.mockImplementation(async (request: { asAt: string }) => {
      const asAt = request.asAt || "2026-10-31";
      return portfolio(asAt, [holding("BHP", { weightPct: asAt === "2026-09-30" ? 8.1 : 8.4 })]);
    });
    const content = await resolveFundSelection(holdingSel("asx:A200", "BHP"));
    expect(content?.heading).toBe("BHP in A200");
    const series = content?.sections?.[0];
    expect(series?.kind).toBe("series");
    if (series?.kind !== "series") throw new Error("expected a series");
    expect(series.items).toEqual([
      { label: "2026-09-30", value: "8.10%" },
      { label: "2026-10-31", value: "8.40%" },
    ]);
    expect(content?.note).toBe("+0.3 percentage points vs 2026-09-30");
  });

  describe("two funds compared (backlog C5)", () => {
    const compared = (fundKey: string, asAt: string, sectors: Array<[string, number]>, codes: string[]) => ({
      ...portfolio(asAt, codes.map((code) => holding(code))),
      fundKey,
      ticker: fundKey.slice(4),
      name: `${fundKey.slice(4)} fund`,
      sectorWeights: sectors.map(([industry, weightPct]) => ({ industry, weightPct, hasWeightPct: true })),
    });

    it("reads the newest file of each fund, and draws the two as one comparison", async () => {
      mockGetFundPortfolio.mockImplementation(async (request: { fundKey: string }) =>
        request.fundKey === "asx:A200"
          ? compared("asx:A200", "2026-11-02", [["Materials", 12]], ["BHP", "RIO"])
          : compared("asx:IOZ", "2026-10-31", [["Banks", 28]], ["CBA"]),
      );
      const content = await resolveFundSelection({ kind: "compare", fundKeys: ["asx:A200", "asx:IOZ"] });
      expect(content?.heading).toBe("A200 vs IOZ");
      expect(content?.subtitle).toBe("A200 at 2026-11-02 · IOZ at 2026-10-31");
      expect(content?.primary?.href).toBe("/ownership/changes?fund=asx%3AA200");
      expect(mockGetFundPortfolio).toHaveBeenCalledTimes(2);
      expect(mockGetFundPortfolio).toHaveBeenCalledWith({ fundKey: "asx:A200", asAt: "" });
      expect(mockGetFundPortfolio).toHaveBeenCalledWith({ fundKey: "asx:IOZ", asAt: "" });
    });

    it("answers a fund the record does not hold with nothing on record, never a half comparison", async () => {
      mockGetFundPortfolio.mockImplementation(async (request: { fundKey: string }) => {
        if (request.fundKey === "asx:ZZZ") throw Object.assign(new Error("not found"), { notFound: true });
        return compared("asx:A200", "2026-11-02", [["Materials", 12]], ["BHP"]);
      });
      expect(await resolveFundSelection({ kind: "compare", fundKeys: ["asx:A200", "asx:ZZZ"] })).toBeNull();
    });

    it("answers a failed read of either fund with the outage note, and no sectors of the other", async () => {
      mockGetFundPortfolio.mockImplementation(async (request: { fundKey: string }) => {
        if (request.fundKey === "asx:IOZ") throw new Error("connection reset");
        return compared("asx:A200", "2026-11-02", [["Materials", 12]], ["BHP"]);
      });
      const content = await resolveFundSelection({ kind: "compare", fundKeys: ["asx:A200", "asx:IOZ"] });
      expect(content?.heading).toBe("Unavailable");
      expect(content?.note).toContain("this is our end");
      expect(content?.sections).toBeUndefined();
    });

    it("names no comparison for a selection with fewer than two keys", async () => {
      mockGetFundPortfolio.mockClear();
      expect(await resolveFundSelection({ kind: "compare", fundKeys: ["asx:A200"] })).toBeNull();
      expect(mockGetFundPortfolio).not.toHaveBeenCalled();
    });

    it("answers a posted selection that is not the codec's shape with nothing, and never throws", async () => {
      mockGetFundPortfolio.mockClear();
      const malformed = [
        { kind: "compare" },
        { kind: "compare", fundKeys: "asx:A200" },
        { kind: "compare", fundKeys: ["asx:A200", "asx:A200"] },
      ] as unknown as Selection[];
      for (const selection of malformed) {
        await expect(resolveFundSelection(selection)).resolves.toBeNull();
      }
      expect(mockGetFundPortfolio).not.toHaveBeenCalled();
    });
  });

  it("answers an outage with a note, not with nothing on record", async () => {
    mockListFunds.mockRejectedValue(new Error("down"));
    const content = await resolveFundSelection(fundSel("asx:A200"));
    expect(content?.heading).toBe("Unavailable");
    expect(content?.note).toContain("this is our end");
  });

  it("resolves a change row against the two dates the page names, and only for a holding", async () => {
    mockCompareFundSnapshots.mockResolvedValue({
      from: "2026-09-30",
      to: "2026-10-31",
      sourceFrom: "",
      sourceTo: "",
      rows: [change("CBA")],
      snapshotDates: [],
    });
    const content = await resolveChangeSelection(holdingSel("asx:IOZ", "CBA"), {
      from: "2026-09-30",
      to: "2026-10-31",
    });
    expect(content?.heading).toBe("CBA in IOZ");
    expect(mockCompareFundSnapshots).toHaveBeenCalledWith({ fundKey: "asx:IOZ", from: "2026-09-30", to: "2026-10-31" });
    expect(await resolveChangeSelection(fundSel("asx:IOZ"), { from: "", to: "" })).toBeNull();
  });
});

describe("the API's fund keys", () => {
  it("loads a fund keyed by its institution slug and name, a name with spaces and a slash included", async () => {
    const key = "vanguard/Vanguard Australian Shares Index Fund";
    mockGetFundPortfolio.mockResolvedValue(portfolio("2026-10-31"));
    const page = await loadFundPortfolio({ fundKey: key });
    expect(page.ok).toBe(true);
    expect(mockGetFundPortfolio).toHaveBeenCalledWith({ fundKey: key, asAt: "" });
  });

  it("refuses a key outside the API's shape without a request", async () => {
    for (const bad of ["A/200", "Vanguard/Name", "vanguard/", "vanguard/ Name", "asx:vas/x"]) {
      mockGetFundPortfolio.mockClear();
      const page = await loadFundPortfolio({ fundKey: bad });
      expect(page.ok).toBe(false);
      expect(mockGetFundPortfolio).not.toHaveBeenCalled();
    }
  });

  it("resolves a holding in the file the page shows, and keeps its series when that file does not state it", async () => {
    mockGetFundPortfolio.mockImplementation(async (request: { asAt: string }) => {
      const asAt = request.asAt || "2026-10-31";
      return asAt === "2026-09-30"
        ? portfolio("2026-09-30", [holding("CBA", { weightPct: 6.2 })])
        : portfolio("2026-10-31", [holding("BHP")]);
    });
    const older = await resolveFundSelection(holdingSel("asx:A200", "CBA"), { asAt: "2026-09-30" });
    expect(mockGetFundPortfolio).toHaveBeenCalledWith({ fundKey: "asx:A200", asAt: "2026-09-30" });
    expect(older?.heading).toBe("CBA in A200");
    expect(older?.figure?.value).toBe("6.20%");
    const newest = await resolveFundSelection(holdingSel("asx:A200", "CBA"));
    expect(newest?.heading).toBe("CBA in A200");
    expect(newest?.note).toBe("CBA is not reported in this file.");
    expect(newest?.sections?.[0]?.kind).toBe("series");
  });

  it("names the fund by its ticker in a change's heading", async () => {
    mockListFunds.mockResolvedValue({ funds: [summary({ fundKey: "asx:IOZ", ticker: "IOZ" })] });
    mockCompareFundSnapshots.mockResolvedValue({
      from: "2026-09-30",
      to: "2026-10-31",
      sourceFrom: "",
      sourceTo: "",
      rows: [change("CBA")],
      snapshotDates: [],
    });
    const content = await resolveChangeSelection(holdingSel("asx:IOZ", "CBA"), { from: "2026-09-30", to: "2026-10-31" });
    expect(content?.heading).toBe("CBA in IOZ");
    expect(content?.primary?.href).toBe("/ownership/funds/asx%3AIOZ?tab=changes&from=2026-09-30&to=2026-10-31");
  });

  it("resolves a holding of a super option by its key, its slash, spaces and comma included", async () => {
    const key = "aware/High Growth, Balanced";
    mockGetFundPortfolio.mockResolvedValue(portfolio("2026-10-31", [holding("BHP", { weightPct: 2.5 })]));
    const content = await resolveFundSelection(holdingSel(key, "BHP"));
    expect(mockGetFundPortfolio).toHaveBeenCalledWith({ fundKey: key, asAt: "" });
    expect(content?.heading).toBe("BHP in A200");
    expect(content?.figure?.value).toBe("2.50%");
  });

  it("refuses an inverted pair of dates without a request, and says why in its error", async () => {
    const page = await compareFundSnapshots({ fundKey: "asx:IOZ", from: "2026-10-31", to: "2026-09-30" });
    expect(page.ok).toBe(false);
    expect(page.error).toContain("from is after to");
    expect(mockCompareFundSnapshots).not.toHaveBeenCalled();
  });
});
