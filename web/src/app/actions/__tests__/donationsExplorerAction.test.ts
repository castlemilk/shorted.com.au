/// <reference types="jest" />

/**
 * The funding explorer's assembly step, and the five things about it that are
 * load-bearing rather than incidental.
 *
 *   - THE YEAR IS PINNED ONCE. An empty financial year means "the latest year
 *     held" and each rpc resolves it independently, so the payer list and the
 *     listed rail are requested for the year the OVERVIEW served. Left to
 *     resolve on their own, an ingest landing between two calls puts two
 *     different years on one page.
 *   - THREE `ok` FLAGS, NOT ONE. A failed fetch and a filter nobody matches both
 *     arrive as zero rows and mean opposite things; the island can only tell
 *     them apart because the action says which happened, per rpc.
 *   - THE LISTED RAIL FANS OUT OVER THE GROUPS THAT HAVE LISTED PAYERS, because
 *     filtering the payer page cannot work: only 6 of the 90 listed payers in
 *     FY2024-25 fall inside the top 200 by amount.
 *   - A PARTIAL FAN-OUT IS NOT OK. Merging two legs of three renders a company's
 *     total across two party groups when three contributed — a wrong figure
 *     rather than a missing one.
 *   - BIGINTS NEVER CROSS THE RSC BOUNDARY. int64 amounts and Timestamps are
 *     both BigInt-backed and `JSON.stringify` throws on either, so the mapping
 *     to plain numbers happens here or the island cannot be handed the page at
 *     all.
 */

const getDonationsOverviewMock = jest.fn();
const listTopDonorsMock = jest.fn();
const listPartyFundingMock = jest.fn();

jest.mock("../getDonations", () => {
  const actual = jest.requireActual("../getDonations");
  return {
    ...actual,
    getDonationsOverview: (...args: unknown[]) => getDonationsOverviewMock(...args),
    listTopDonors: (...args: unknown[]) => listTopDonorsMock(...args),
    listPartyFunding: (...args: unknown[]) => listPartyFundingMock(...args),
  };
});

jest.mock("@/lib/politics/timestamp", () => ({
  toDate: (value: unknown) => (value ? new Date("2026-08-01T00:00:00.000Z") : undefined),
}));

function overview(overrides: Record<string, unknown> = {}) {
  return {
    // The year SERVED, deliberately different from any year requested below.
    financialYear: "2024-25",
    parties: [
      {
        partyGroup: "Australian Labor Party",
        financialYear: "2024-25",
        financialYearEnd: 2025,
        partyReturnCount: 9,
        totalReceiptsCents: 16_175_271_700n,
        itemisedReceiptsCents: 12_507_842_500n,
        declaredDonationsCents: 1_594_911_300n,
        distinctPayerCount: 1265,
        distinctDonorCount: 210,
        listedPayerCount: 50,
        thresholdCensored: true,
        postReformScheme: false,
      },
      {
        partyGroup: "Liberal",
        financialYear: "2024-25",
        financialYearEnd: 2025,
        partyReturnCount: 8,
        totalReceiptsCents: 20_544_268_400n,
        itemisedReceiptsCents: 13_033_198_500n,
        declaredDonationsCents: 3_066_723_200n,
        distinctPayerCount: 459,
        distinctDonorCount: 190,
        listedPayerCount: 25,
        thresholdCensored: true,
        postReformScheme: false,
      },
      {
        // No listed payer: the rail must not fan out to this one.
        partyGroup: "Socialist Alliance",
        financialYear: "2024-25",
        financialYearEnd: 2025,
        partyReturnCount: 1,
        totalReceiptsCents: 15_952_500n,
        itemisedReceiptsCents: 0n,
        declaredDonationsCents: 400_000n,
        distinctPayerCount: 0,
        distinctDonorCount: 1,
        listedPayerCount: 0,
        thresholdCensored: true,
        postReformScheme: false,
      },
    ],
    availableFinancialYears: [
      { financialYear: "2024-25", financialYearEnd: 2025, partyGroupCount: 42 },
      { financialYear: "2023-24", financialYearEnd: 2024, partyGroupCount: 40 },
    ],
    corpus: {
      partyReturnCount: 4000,
      receiptCount: 124_000,
      donationMadeCount: 66_000,
      mpReturnCount: 52,
      mpReturnResolvedCount: 41,
      candidateReturnCount: 1461,
      candidateReturnResolvedCount: 120,
      nilCandidateReturnCount: 1067,
      candidateDonationCount: 900,
      firstFinancialYearEnd: 1999,
      lastFinancialYearEnd: 2025,
      matchedPayerNameCount: 185,
    },
    censoringNote: "SERVED CENSORING NOTE.",
    reformNote: "SERVED REFORM NOTE.",
    coverageNote: "SERVED COVERAGE NOTE.",
    verbatimNote: "SERVED VERBATIM NOTE.",
    sourceLicence: "CC-BY-4.0",
    attribution: "© Commonwealth of Australia — AEC Transparency Register",
    asAt: { seconds: 1n, nanos: 0 },
    ...overrides,
  };
}

function donor(overrides: Record<string, unknown> = {}) {
  return {
    donorName: "Example Holdings Pty Ltd",
    donorNameNorm: "example holdings",
    totalCents: 25_000_000n,
    receiptTypes: {
      donationCents: 15_000_000n,
      otherReceiptCents: 6_000_000n,
      subscriptionCents: 4_000_000n,
      publicFundingCents: 0n,
      unspecifiedCents: 0n,
    },
    receiptCount: 4,
    recipients: [{ partyGroup: "Australian Labor Party", amountCents: 25_000_000n }],
    stockCode: "",
    companyName: "",
    matchMethod: "",
    ...overrides,
  };
}

function topDonors(overrides: Record<string, unknown> = {}) {
  return {
    financialYear: "2024-25",
    partyGroup: "",
    donors: [donor()],
    total: 1265,
    scopeNote: "SERVED DONOR SCOPE NOTE.",
    censoringNote: "SERVED CENSORING NOTE.",
    reformNote: "SERVED REFORM NOTE.",
    verbatimNote: "SERVED VERBATIM NOTE.",
    sourceLicence: "CC-BY-4.0",
    attribution: "© Commonwealth of Australia — AEC Transparency Register",
    asAt: { seconds: 1n, nanos: 0 },
    ...overrides,
  };
}

function partyFunding(group: string, listed: Record<string, unknown>[]) {
  return {
    partyGroup: group,
    series: [{ partyGroup: group, financialYear: "2024-25", financialYearEnd: 2025 }],
    financialYear: "2024-25",
    topDonors: [],
    listedCompanyPayers: listed,
    branchNames: [`${group} (NSW Branch)`],
    censoringNote: "SERVED CENSORING NOTE.",
    reformNote: "SERVED REFORM NOTE.",
    verbatimNote: "SERVED VERBATIM NOTE.",
    sourceLicence: "CC-BY-4.0",
    attribution: "© Commonwealth of Australia — AEC Transparency Register",
    asAt: { seconds: 1n, nanos: 0 },
  };
}

function listedBhp(group: string, amount: bigint) {
  return donor({
    donorName: "BHP Group Limited",
    donorNameNorm: "bhp group",
    totalCents: amount,
    receiptTypes: {
      donationCents: amount,
      otherReceiptCents: 0n,
      subscriptionCents: 0n,
      publicFundingCents: 0n,
      unspecifiedCents: 0n,
    },
    receiptCount: 1,
    recipients: [{ partyGroup: group, amountCents: amount }],
    stockCode: "BHP",
    companyName: "BHP Group Ltd",
    matchMethod: "name_exact",
  });
}

async function loadAction() {
  const mod = await import("../donationsExplorer");
  return mod.loadDonationsExplorer;
}

describe("donations explorer action", () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    getDonationsOverviewMock.mockResolvedValue(overview());
    listTopDonorsMock.mockResolvedValue(topDonors());
    listPartyFundingMock.mockImplementation(async (group: string) =>
      partyFunding(group, [listedBhp(group, group === "Liberal" ? 5_000_000n : 3_000_000n)]),
    );
  });

  it("pins every later request to the year the overview actually served", async () => {
    const load = await loadAction();

    // The reader asked for nothing; the server resolves "latest year held".
    const page = await load({ financialYear: "" });

    expect(page.financialYear).toBe("2024-25");
    expect(listTopDonorsMock).toHaveBeenCalledWith(
      expect.objectContaining({ financialYear: "2024-25" }),
    );
    for (const call of listPartyFundingMock.mock.calls) {
      expect(call[1]).toBe("2024-25");
    }
    // And the echoed query carries the served year, so the island's caption and
    // its next request agree with the figures on screen.
    expect(page.query.financialYear).toBe("2024-25");
  });

  it("fans the listed rail out over exactly the groups holding listed payers", async () => {
    const load = await loadAction();

    const page = await load({});

    expect(listPartyFundingMock.mock.calls.map((call) => call[0])).toEqual([
      "Australian Labor Party",
      "Liberal",
    ]);
    // Never the group with no listed payer: one wasted rpc per render, and a
    // scope line naming a party that contributed nothing.
    expect(page.listedGroups).not.toContain("Socialist Alliance");
    expect(page.listedOmittedGroupCount).toBe(0);
  });

  it("merges one company across party groups and keeps every recipient named", async () => {
    const load = await loadAction();

    const page = await load({});

    expect(page.listedPayers).toHaveLength(1);
    const bhp = page.listedPayers[0]!;
    // 3,000,000c + 5,000,000c — the SAME measure on both sides, so the addition
    // is one the source supports.
    expect(bhp.totalCents).toBe(8_000_000);
    expect(bhp.split.donation).toBe(8_000_000);
    expect(bhp.recipients.map((r) => r.partyGroup).sort()).toEqual([
      "Australian Labor Party",
      "Liberal",
    ]);
  });

  it("scopes the listed rail to one group when a party filter is set", async () => {
    const load = await loadAction();

    const page = await load({ partyGroup: "Liberal" });

    expect(listPartyFundingMock.mock.calls.map((call) => call[0])).toEqual(["Liberal"]);
    expect(page.listedGroups).toEqual(["Liberal"]);
  });

  it("marks a partial fan-out as not ok rather than publishing a short total", async () => {
    listPartyFundingMock.mockImplementation(async (group: string) =>
      group === "Liberal" ? undefined : partyFunding(group, [listedBhp(group, 3_000_000n)]),
    );
    const load = await loadAction();

    const page = await load({});

    // A merged figure missing one contributing group is WRONG, not missing —
    // the rail says so instead of drawing it.
    expect(page.listedOk).toBe(false);
  });

  it("reports the three ok flags independently", async () => {
    listTopDonorsMock.mockResolvedValue(undefined);
    const load = await loadAction();

    const page = await load({});

    expect(page.overviewOk).toBe(true);
    expect(page.payersOk).toBe(false);
    // A dead payer list must not blank healthy party bars.
    expect(page.parties.length).toBeGreaterThan(0);
  });

  it("never throws, whatever the rpcs do", async () => {
    getDonationsOverviewMock.mockRejectedValue(new Error("cold start"));
    listTopDonorsMock.mockRejectedValue(new Error("cold start"));
    listPartyFundingMock.mockRejectedValue(new Error("cold start"));
    const load = await loadAction();

    const page = await load({});

    expect(page.overviewOk).toBe(false);
    expect(page.payersOk).toBe(false);
    expect(page.parties).toEqual([]);
    // And no note is invented to fill the gap: an empty string renders nothing.
    expect(page.notes.censoring).toBe("");
  });

  it("maps every amount to a plain number so the page can cross the RSC boundary", async () => {
    const load = await loadAction();

    const page = await load({});

    expect(typeof page.parties[0]!.totalReceiptsCents).toBe("number");
    expect(typeof page.payers[0]!.totalCents).toBe("number");
    expect(typeof page.payers[0]!.split.subscription).toBe("number");
    // The whole point: BigInt makes JSON.stringify throw, and the island is
    // handed this object across the boundary.
    expect(() => JSON.stringify(page)).not.toThrow();
  });

  it("carries the served notes through verbatim and invents none", async () => {
    const load = await loadAction();

    const page = await load({});

    expect(page.notes.censoring).toBe("SERVED CENSORING NOTE.");
    expect(page.notes.reform).toBe("SERVED REFORM NOTE.");
    expect(page.notes.coverage).toBe("SERVED COVERAGE NOTE.");
    expect(page.notes.donorScope).toBe("SERVED DONOR SCOPE NOTE.");
    expect(page.notes.attribution).toContain("Commonwealth of Australia");
    expect(page.notes.licence).toBe("CC-BY-4.0");
  });

  it("clamps the page size and the offset before anything is requested", async () => {
    const load = await loadAction();

    await load({ limit: 5000, offset: -3 });

    expect(listTopDonorsMock).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200, offset: 0 }),
    );
  });

  it("states the payer total from the response, not the length of the page", async () => {
    const load = await loadAction();

    const page = await load({});

    // The real population, so the surface never reports the rows it happened to
    // render as the number of payers there are.
    expect(page.payerTotal).toBe(1265);
    expect(page.payers).toHaveLength(1);
  });
});
