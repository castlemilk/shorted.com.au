/// <reference types="jest" />

/**
 * The holders workspace's actions (app/actions/ownershipHolders.ts) and what is
 * load-bearing about them:
 *
 *   - AN OUTAGE IS NOT A REFUSAL. The retry wrapper's undefined is ok: false with an
 *     empty error; a key the register does not list is refused with its reason, and
 *     no request is made for it.
 *   - THE CAPS JOIN. A stock's market cap comes from the desk's map; a stock the map
 *     does not hold has none (null, never zero). A map that cannot be read still
 *     serves the connections, with capsOk false and every width a hairline.
 *   - THE INSPECTOR RESOLVER. An unreadable holder resolves to null, so the rail says
 *     it could not be read; a readable one resolves to the selection's content.
 */

import { NotFoundError } from "../withRetry";

const mockGetInstitution = jest.fn();
const mockListInstitutions = jest.fn();
const mockLoadOwnershipMap = jest.fn();
const mockLoadNoticeFeed = jest.fn();

jest.mock("../getOwnership", () => ({
  getInstitution: (slug: string) => mockGetInstitution(slug),
  getInstitutionOrNotFound: (slug: string) => mockGetInstitution(slug),
  listInstitutions: (kind: string, query: string, limit: number, offset: number) =>
    mockListInstitutions(kind, query, limit, offset),
}));

jest.mock("../ownershipDesk", () => ({
  loadOwnershipMap: (input: unknown) => mockLoadOwnershipMap(input),
}));

// The strip's notices are the feed's; its own tests are in ownershipExplorer.test.ts.
jest.mock("../ownershipExplorer", () => ({
  loadNoticeFeed: (input: unknown) => mockLoadNoticeFeed(input),
}));

import { loadHolderConnections, loadHolders, loadHolderWeekNotices, resolveHolderInspector } from "../ownershipHolders";

const institution = {
  slug: "vanguard",
  name: "Vanguard",
  kind: "index_manager",
  website: "https://www.vanguard.com.au",
  substantialPositions: 2,
  latestNoticeDate: "2026-11-02",
};

const answer = (overrides: Record<string, unknown> = {}) => ({
  institution,
  positions: [
    {
      stockCode: "BHP",
      companyName: "BHP Group",
      industry: "Materials",
      votingPowerPct: 6,
      eventDate: "2026-10-14",
      announcementUrl: "https://www.asx.com.au/bhp.pdf",
    },
    {
      stockCode: "NEW",
      companyName: "New Co",
      industry: "Banks",
      votingPowerPct: 5,
      eventDate: "2026-10-15",
      announcementUrl: "https://www.asx.com.au/new.pdf",
    },
  ],
  funds: [
    { fundKey: "VGS", name: "Vanguard MSCI Index", asxCode: "VGS", fundType: "etf", hasSize: true, sizeAud: 1e10 },
    { fundKey: "VAS", name: "Vanguard Australian", asxCode: "VAS", fundType: "etf", hasSize: false, sizeAud: 0 },
  ],
  ...overrides,
});

const map = (stocks: Array<{ code: string; marketCap: number | null }>) => ({
  ok: true,
  error: "",
  from: "",
  to: "",
  asOf: "",
  stocks,
});

describe("loadHolders (the directory)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is an outage, not an empty answer, when the directory does not answer", async () => {
    mockListInstitutions.mockResolvedValue(undefined);
    await expect(loadHolders()).resolves.toEqual({ ok: false, error: "", holders: [], total: 0 });
  });

  it("maps each institution to a holder row, in the directory's order", async () => {
    mockListInstitutions.mockResolvedValue({
      institutions: [institution, { ...institution, slug: "hesta", name: "HESTA", kind: "super_fund", substantialPositions: 1 }],
      total: 2,
    });
    const page = await loadHolders();
    expect(page.ok).toBe(true);
    expect(page.holders.map((h) => h.key)).toEqual(["vanguard", "hesta"]);
    expect(page.holders[0]).toEqual({
      key: "vanguard",
      name: "Vanguard",
      kind: "index_manager",
      website: "https://www.vanguard.com.au",
      positions: 2,
      latestNoticeDate: "2026-11-02",
      positionsGained: 0,
    });
    expect(page.total).toBe(2);
  });

  it("carries each holder's positions gained in the window, and reads an omitted count as none", async () => {
    mockListInstitutions.mockResolvedValue({
      institutions: [
        { ...institution, positionsGained: 3 },
        { ...institution, slug: "hesta", name: "HESTA", kind: "super_fund", substantialPositions: 1, positionsGained: 0 },
        { ...institution, slug: "quiet", name: "Quiet", kind: "hedge_fund", substantialPositions: 2 },
      ],
      total: 3,
    });
    const page = await loadHolders();
    expect(page.holders.map((h) => [h.key, h.positionsGained])).toEqual([
      ["vanguard", 3],
      ["hesta", 0],
      ["quiet", 0],
    ]);
  });
});

describe("loadHolderConnections (one holder's connections)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadOwnershipMap.mockResolvedValue(map([{ code: "BHP", marketCap: 2e11 }]));
  });

  it("refuses a key the register cannot list, with its reason, and makes no request", async () => {
    for (const key of ["asx:BHP", "name:someone", "Vanguard", ""]) {
      const page = await loadHolderConnections(key);
      expect(page).toMatchObject({ ok: false, error: "not a holder the register lists", holder: null });
    }
    expect(mockGetInstitution).not.toHaveBeenCalled();
    expect(mockLoadOwnershipMap).not.toHaveBeenCalled();
  });

  it("is an outage, with no reason, when the institution does not answer", async () => {
    mockGetInstitution.mockResolvedValue(undefined);
    await expect(loadHolderConnections("vanguard")).resolves.toMatchObject({ ok: false, error: "", holder: null });
  });

  it("joins each position to its stock's market cap, and carries the holder's funds", async () => {
    mockGetInstitution.mockResolvedValue(answer());
    const page = await loadHolderConnections("vanguard");
    expect(page.ok).toBe(true);
    expect(page.capsOk).toBe(true);
    expect(page.holder?.key).toBe("vanguard");
    expect(page.positions.find((p) => p.stockCode === "BHP")?.marketCap).toBe(2e11);
    expect(page.positions.find((p) => p.stockCode === "NEW")?.marketCap).toBeNull();
    expect(page.funds).toEqual([
      { key: "VGS", name: "Vanguard MSCI Index", asxCode: "VGS", fundType: "etf", sizeAud: 1e10 },
      { key: "VAS", name: "Vanguard Australian", asxCode: "VAS", fundType: "etf", sizeAud: null },
    ]);
  });

  it("serves the connections with every width a hairline when the map cannot be read", async () => {
    mockGetInstitution.mockResolvedValue(answer());
    mockLoadOwnershipMap.mockResolvedValue({ ok: false, error: "", from: "", to: "", asOf: "", stocks: [] });
    const page = await loadHolderConnections("vanguard");
    expect(page.ok).toBe(true);
    expect(page.capsOk).toBe(false);
    expect(page.positions).toHaveLength(2);
    expect(page.positions.every((p) => p.marketCap === null)).toBe(true);
  });
});

describe("resolveHolderInspector (the inspector's content)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadOwnershipMap.mockResolvedValue(map([{ code: "BHP", marketCap: 2e11 }]));
  });

  it("refuses a key the register does not list, apart from an outage", async () => {
    mockGetInstitution.mockRejectedValue(new NotFoundError("no such institution"));
    const page = await loadHolderConnections("vanguard");
    expect(page.ok).toBe(false);
    expect(page.error).toBe("The register lists no holder under this key.");
  });

  it("resolves to null for an unreadable holder, so the rail says it could not be read", async () => {
    mockGetInstitution.mockResolvedValue(undefined);
    await expect(resolveHolderInspector("vanguard", "")).resolves.toBeNull();
    await expect(resolveHolderInspector("asx:BHP", "stock:BHP")).resolves.toBeNull();
  });

  it("resolves a readable holder to the content of its selection, with its funds", async () => {
    mockGetInstitution.mockResolvedValue(answer());
    const content = await resolveHolderInspector("vanguard", "stock:BHP");
    expect(content?.heading).toBe("Vanguard");
    expect(content?.sections?.[0]?.title).toBe("BHP · Materials");
    expect(content?.connectionLink?.href).toBe("https://www.asx.com.au/bhp.pdf");
    expect(content?.funds.map((f) => f.key)).toEqual(["VGS", "VAS"]);
  });
});

describe("the holder's notices by week (backlog C6)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadOwnershipMap.mockResolvedValue({ ...map([{ code: "BHP", marketCap: 2e11 }]), asOf: "2026-10-31" });
    mockLoadNoticeFeed.mockResolvedValue({
      ok: true,
      total: 2,
      rows: [{ released: "2026-10-20" }, { released: "2026-08-03" }],
      nextCursor: "",
      weeks: [],
      query: {},
      activityOk: true,
      error: "",
    });
  });

  it("reads the holder's notices over the 26 weeks ending on the map's as-of, for the holder's slug", async () => {
    mockGetInstitution.mockResolvedValue(answer());
    const page = await loadHolderConnections("vanguard");
    expect(mockLoadNoticeFeed).toHaveBeenCalledWith({
      institutionSlug: "vanguard",
      since: "2026-05-04",
      until: "2026-10-31",
      limit: 100,
      includeActivity: false,
    });
    expect(page.weekNotices).toEqual({ asOf: "2026-10-31", released: ["2026-10-20", "2026-08-03"] });
  });

  it("draws the strip in the holder's inspector, after its positions", async () => {
    mockGetInstitution.mockResolvedValue(answer());
    const content = await resolveHolderInspector("vanguard", "stock:BHP");
    const strip = content?.sections?.find((section) => section.title === "Notices by week");
    expect(strip?.kind).toBe("weeks");
    if (strip?.kind !== "weeks") throw new Error("the strip is a weeks section");
    expect(strip.weeks.find((week) => week.weekStart === "2026-10-19")?.href).toBe(
      "/ownership/notices?holder=vanguard&since=2026-10-19&until=2026-10-25",
    );
  });

  it("drops the strip when the feed did not answer, and never reads it for a holder not listed", async () => {
    mockGetInstitution.mockResolvedValue(answer());
    mockLoadNoticeFeed.mockResolvedValue({ ok: false, total: 0, rows: [], nextCursor: "", weeks: [], query: {}, activityOk: false, error: "" });
    const content = await resolveHolderInspector("vanguard", "");
    expect(content?.sections?.some((section) => section.title === "Notices by week")).toBe(false);

    mockGetInstitution.mockRejectedValue(new NotFoundError("no such institution"));
    mockLoadNoticeFeed.mockClear();
    await loadHolderConnections("vanguard");
    expect(mockLoadNoticeFeed).not.toHaveBeenCalled();
  });

  it("drops the strip when the map has no as-of to end it on", async () => {
    mockGetInstitution.mockResolvedValue(answer());
    mockLoadOwnershipMap.mockResolvedValue(map([{ code: "BHP", marketCap: 2e11 }]));
    const page = await loadHolderConnections("vanguard");
    expect(mockLoadNoticeFeed).not.toHaveBeenCalled();
    expect(page.weekNotices).toBeNull();
  });

  it("reads the feed's second page with the first page's cursor, and counts the notices of both", async () => {
    mockLoadNoticeFeed
      .mockResolvedValueOnce({
        ok: true,
        total: 3,
        rows: [{ released: "2026-10-20" }, { released: "2026-10-21" }],
        nextCursor: "page-2",
        weeks: [],
        query: {},
        activityOk: true,
        error: "",
      })
      .mockResolvedValueOnce({
        ok: true,
        total: 3,
        rows: [{ released: "2026-08-03" }],
        nextCursor: "",
        weeks: [],
        query: {},
        activityOk: true,
        error: "",
      });
    const notices = await loadHolderWeekNotices("vanguard", "2026-10-31");
    expect(mockLoadNoticeFeed).toHaveBeenCalledTimes(2);
    expect(mockLoadNoticeFeed).toHaveBeenNthCalledWith(2, {
      institutionSlug: "vanguard",
      since: "2026-05-04",
      until: "2026-10-31",
      limit: 100,
      includeActivity: false,
      cursor: "page-2",
    });
    expect(notices?.released).toEqual(["2026-10-20", "2026-10-21", "2026-08-03"]);
  });

  it("reads nothing for a key that is not a holder's slug, since the export is a server action", async () => {
    const notices = await loadHolderWeekNotices("not a slug", "2026-10-31");
    expect(mockLoadNoticeFeed).not.toHaveBeenCalled();
    expect(notices).toBeNull();
  });
});
