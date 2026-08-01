/// <reference types="jest" />

/**
 * The activity explorer's data path (/politicians/changes), and the four things
 * about it that are load-bearing rather than incidental.
 *
 *   - THE WINDOW THE RESPONSE REPORTS IS THE ONE TO RENDER. The backend rounds a
 *     window UP to the next one it serves (45 -> 90) and echoes back the window
 *     it used. Captioning the REQUEST would put "45 days" over 90 days of events
 *     — and, worse, would derive the feed's `since` from a window the strip
 *     beside it does not have.
 *   - AN OUTAGE IS NOT AN EMPTY FILTER. Both arrive as zero rows and mean
 *     opposite things, so the two rpcs report separately (`ok`, `railsOk`). A
 *     collapsed flag lets the island word our downtime as "no register events
 *     match" — an absence claim about every member the filter covers.
 *   - AN EMPTY CACHE ENTRY IS A MISS, NOT A HIT. `{}` parses into a valid
 *     message whose counts are all zero; a truthy `if (hit)` then serves zeros
 *     for the full 24h TTL while every rpc behind it is healthy. That is what
 *     /politicians served after the 2026-07-31 deploy.
 *   - EVERY CLAMPED INPUT IS IN THE CACHE KEY, under `cache:politicians:` so
 *     `/api/revalidate?flush=politicians` clears it. A key that omits an input
 *     serves one filter's events under another filter's name, which on this
 *     surface means one member's register events beside a different member's.
 */

import { TextDecoder, TextEncoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

const createConnectTransportMock = jest.fn();
const createClientMock = jest.fn();
const clientMock = {
  getRegisterActivity: jest.fn(),
  listRegisterChanges: jest.fn(),
};

const getCachedMock = jest.fn();
const setCachedMock = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (...args: unknown[]) => createConnectTransportMock(...args),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: (...args: unknown[]) => createClientMock(...args),
}));

/**
 * The global setup mock of @bufbuild/protobuf has no `toJson`, and the writer
 * wraps its call in a try/catch (a cache write must never break a render). Left
 * alone, the write silently no-ops and an assertion that it HAPPENED passes for
 * the wrong reason.
 */
jest.mock("@bufbuild/protobuf", () => ({
  fromJson: jest.fn((_schema: unknown, data: unknown) => data ?? {}),
  toJson: jest.fn((_schema: unknown, data: unknown) => data ?? {}),
  create: jest.fn((_schema: unknown, data: unknown) => data ?? {}),
}));

jest.mock("@/lib/kv-cache", () => {
  const actual = jest.requireActual("@/lib/kv-cache");
  return {
    ...actual,
    getCached: (...args: unknown[]) => getCachedMock(...args),
    setCached: (...args: unknown[]) => setCachedMock(...args),
  };
});

/** RegisterHolder.SPOUSE_PARTNER, without importing the generated enum here. */
const HOLDER_SPOUSE = 2;
/** RegisterChangeKind.ADDED. */
const KIND_ADDED = 1;

const ACTIVITY = {
  // The CLAMPED window, which is the whole point of the first test below.
  windowDays: 90,
  weeks: [
    { weekStart: "2026-06-29", addedCount: 4, removedCount: 1 },
    { weekStart: "2026-07-06", addedCount: 2, removedCount: 0 },
  ],
  activeMembers: [
    { slug: "a-member", displayName: "A Member", partyAb: "ALP", chamber: "house", division: "Example", eventCount: 5 },
  ],
  newlyDeclaredCompanies: [
    { stockCode: "ABC", companyName: "ABC Ltd", industry: "Materials", firstDeclaredOn: "2026-07-02", declarerCount: 2 },
  ],
  declarerCountChanges: [
    { stockCode: "XYZ", companyName: "XYZ Ltd", industry: "Energy", declarersNow: 5, declarersAtWindowStart: 3 },
  ],
  undatedCurrentCount: 1234,
};

const FEED = {
  events: [
    {
      politician: { slug: "a-member", displayName: "A Member", partyAb: "ALP" },
      kind: KIND_ADDED,
      itemNo: 1,
      itemLabel: "Shareholdings",
      holder: HOLDER_SPOUSE,
      declaredText: "ABC Ltd",
      stockCode: "ABC",
      companyName: "ABC Ltd",
      entityKind: "listed",
      changedOn: { seconds: BigInt(Math.floor(Date.UTC(2026, 6, 2) / 1000)), nanos: 0 },
    },
  ],
  total: 42,
};

async function loadActions() {
  return import("../registerActivity");
}

describe("register activity action", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      SHORTS_SERVICE_ENDPOINT: "https://shorts-prod.run.app",
    };
    delete process.env.SKIP_STATIC_GENERATION;
    createConnectTransportMock.mockReturnValue({});
    createClientMock.mockReturnValue(clientMock);
    getCachedMock.mockResolvedValue(null);
    setCachedMock.mockResolvedValue(true);
    clientMock.getRegisterActivity.mockResolvedValue(ACTIVITY);
    clientMock.listRegisterChanges.mockResolvedValue(FEED);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("rounds a window UP, exactly as the handler does", async () => {
    const { clampRegisterActivityWindow } = await import("../getPoliticians");

    // The rule from politicians_discovery.go: a request between two windows gets
    // the LARGER one, so a caller never receives less than it asked for.
    expect(clampRegisterActivityWindow(45)).toBe(90);
    expect(clampRegisterActivityWindow(30)).toBe(30);
    expect(clampRegisterActivityWindow(200)).toBe(365);
    expect(clampRegisterActivityWindow(4000)).toBe(365);
    // Zero and negatives are the handler's default, not "everything".
    expect(clampRegisterActivityWindow(0)).toBe(90);
    expect(clampRegisterActivityWindow(-7)).toBe(90);
  });

  it("renders the window the RESPONSE reports, not the one requested", async () => {
    const { loadRegisterActivity } = await loadActions();

    const page = await loadRegisterActivity({ windowDays: 45 });

    // 45 is not a window the backend serves; 90 is what produced these numbers.
    expect(page.windowDays).toBe(90);
    expect(page.query.windowDays).toBe(90);
    expect(clientMock.getRegisterActivity).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 90 }),
    );

    // And the feed's lower bound comes from the SAME window, so the strip and
    // the feed below it can never describe different spans.
    const since = clientMock.listRegisterChanges.mock.calls[0]?.[0]?.since;
    expect(since).toBeDefined();
    const days = Math.round(
      (Date.now() - Number(since.seconds) * 1000) / 86_400_000,
    );
    expect(days).toBeGreaterThanOrEqual(90);
    expect(days).toBeLessThanOrEqual(91);
  });

  it("normalises every feed filter to what the backend will do with it", async () => {
    const { clampRegisterChangeFeedQuery } = await import("../getPoliticians");

    expect(
      clampRegisterChangeFeedQuery({
        since: "not-a-date",
        kind: "sold" as never,
        politicianSlug: "  A-Member ",
        itemNo: 99,
        partyAb: "alp",
        chamber: "House",
        limit: 5000,
        offset: -3,
      }),
    ).toEqual({
      since: "",
      kind: "",
      politicianSlug: "a-member",
      itemNo: 0,
      partyAb: "ALP",
      chamber: "house",
      limit: 500,
      offset: 0,
    });

    expect(clampRegisterChangeFeedQuery({}).limit).toBe(100);
    expect(clampRegisterChangeFeedQuery({ itemNo: 3 }).itemNo).toBe(3);
    expect(clampRegisterChangeFeedQuery({ kind: "removed" }).kind).toBe("removed");
  });

  it("puts every clamped input in a key the politicians flush clears", async () => {
    const { CACHE_KEYS } = jest.requireActual("@/lib/kv-cache") as typeof import("@/lib/kv-cache");

    const key = CACHE_KEYS.registerChangeFeed(
      "2026-04-03",
      "added",
      "a-member",
      3,
      "ALP",
      "house",
      100,
      0,
    );
    expect(key).toContain("cache:politicians:");
    expect(key).toContain("a-member");
    expect(key).toContain("ALP");
    expect(key).toContain("house");
    // Two different filters can never collide on one entry.
    expect(key).not.toBe(
      CACHE_KEYS.registerChangeFeed("2026-04-03", "added", "b-member", 3, "ALP", "house", 100, 0),
    );

    // The activity key is the CLAMPED window plus EVERY filter, for the same two
    // reasons: 45 and 90 cannot hold two entries for one identical response, and
    // two filters cannot share one entry now that the filters narrow the weekly
    // buckets and both filtered counts.
    expect(CACHE_KEYS.registerActivity(90, "", "", 0, "", "")).toBe(
      "cache:politicians:activity:90:all:all:0:all:all",
    );
    expect(CACHE_KEYS.registerActivity(90, "added", "a-member", 3, "ALP", "house")).toContain(
      "a-member",
    );
    expect(CACHE_KEYS.registerActivity(90, "added", "a-member", 3, "ALP", "house")).not.toBe(
      CACHE_KEYS.registerActivity(90, "added", "b-member", 3, "ALP", "house"),
    );
  });

  it("narrows the strip by the SAME filters the feed uses", async () => {
    const { loadRegisterActivity } = await loadActions();

    await loadRegisterActivity({
      windowDays: 30,
      kind: "added",
      politicianSlug: " A-Member ",
      itemNo: 3,
      partyAb: "alp",
      chamber: "House",
    });

    // Clamped exactly as the feed's own query is, so the strip above the feed
    // and the feed below it can never be narrowed by two different readings of
    // one filter set.
    expect(clientMock.getRegisterActivity).toHaveBeenCalledWith({
      windowDays: 30,
      kind: KIND_ADDED,
      politicianSlug: "a-member",
      itemNo: 3,
      partyAb: "ALP",
      chamber: "house",
    });
  });

  it("publishes the response's own filtered counts, never a count of the rows", async () => {
    clientMock.getRegisterActivity.mockResolvedValue({
      ...ACTIVITY,
      filteredEventCount: 7,
      filteredMemberCount: 4,
    });
    const { loadRegisterActivity } = await loadActions();

    const page = await loadRegisterActivity({});

    // `events` is one page of a paginated feed: a member count derived from it
    // is a floor that shrinks as the reader pages forward.
    expect(page.filteredEventCount).toBe(7);
    expect(page.filteredMemberCount).toBe(4);
    expect(page.events).toHaveLength(1);
  });

  it("maps an event to plain JSON with the register's own holder wording", async () => {
    const { loadRegisterActivity } = await loadActions();

    const page = await loadRegisterActivity({});
    const event = page.events[0];

    expect(event?.slug).toBe("a-member");
    expect(event?.kind).toBe("added");
    // Locked in the compliance kit and repeated verbatim here: the register's
    // own attribute, never a paraphrase and never inferred.
    expect(event?.holderLabel).toBe("Spouse/partner");
    expect(event?.stockCode).toBe("ABC");
    expect(event?.changedOn).toBe("2026-07-02");
    expect(event?.dateLabel).toContain("2026");
    // A proto message would carry BigInt-backed Timestamps and a $typeName, and
    // neither survives the RSC boundary.
    expect(JSON.stringify(page.events)).toContain("a-member");
  });

  it("drops an event that cannot be attributed to anyone", async () => {
    clientMock.listRegisterChanges.mockResolvedValue({
      events: [{ ...FEED.events[0], politician: undefined }, FEED.events[0]],
      total: 2,
    });
    const { loadRegisterActivity } = await loadActions();

    const page = await loadRegisterActivity({});

    expect(page.events).toHaveLength(1);
    expect(page.events[0]?.displayName).toBe("A Member");
  });

  it("publishes the undated count rather than dropping it silently", async () => {
    const { loadRegisterActivity } = await loadActions();

    const page = await loadRegisterActivity({});

    expect(page.undatedCurrentCount).toBe(1234);
  });

  it("reports a feed outage and an empty filter as different results", async () => {
    const { loadRegisterActivity } = await loadActions();

    // An honest empty answer: the request answered, and nothing matched.
    clientMock.listRegisterChanges.mockResolvedValue({ events: [], total: 0 });
    const empty = await loadRegisterActivity({ politicianSlug: "nobody-here" });
    expect(empty.ok).toBe(true);
    expect(empty.events).toHaveLength(0);

    // Our own downtime, which must never be worded as an empty filter.
    jest.resetModules();
    clientMock.listRegisterChanges.mockRejectedValue(new Error("upstream is down"));
    const { loadRegisterActivity: reloaded } = await loadActions();
    const down = await reloaded({});
    expect(down.ok).toBe(false);
    expect(down.events).toHaveLength(0);
  });

  it("keeps a healthy feed when only the rails fail", async () => {
    clientMock.getRegisterActivity.mockRejectedValue(new Error("upstream is down"));
    const { loadRegisterActivity } = await loadActions();

    const page = await loadRegisterActivity({ windowDays: 30 });

    expect(page.railsOk).toBe(false);
    expect(page.weeks).toHaveLength(0);
    // The feed still answered, and the window falls back to our own clamp —
    // which agrees with the backend's by construction.
    expect(page.ok).toBe(true);
    expect(page.windowDays).toBe(30);
    expect(page.events).toHaveLength(1);
  });

  it("treats a zeroed rails cache entry as a miss and refetches", async () => {
    // The shape a cold materialized view or the register kill switch returns:
    // well formed, and empty of every measure the page renders.
    getCachedMock.mockImplementation(async (key: string) =>
      key.startsWith("cache:politicians:activity:")
        ? { windowDays: 90, weeks: [], activeMembers: [], undatedCurrentCount: 0 }
        : null,
    );
    const { loadRegisterActivity } = await loadActions();

    const page = await loadRegisterActivity({});

    expect(clientMock.getRegisterActivity).toHaveBeenCalledTimes(1);
    expect(page.weeks).toHaveLength(2);
  });

  it("never caches an empty response", async () => {
    clientMock.getRegisterActivity.mockResolvedValue({
      windowDays: 90,
      weeks: [],
      activeMembers: [],
      undatedCurrentCount: 0,
    });
    clientMock.listRegisterChanges.mockResolvedValue({ events: [], total: 0 });
    const { loadRegisterActivity } = await loadActions();

    await loadRegisterActivity({});

    expect(setCachedMock).not.toHaveBeenCalled();
  });
});
