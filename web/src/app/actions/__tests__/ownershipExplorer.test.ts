/// <reference types="jest" />

/**
 * The explorer's two list actions (/ownership/notices and /ownership/stocks)
 * and what is load-bearing about them:
 *
 *   - AN OUTAGE IS NOT AN EMPTY ANSWER. The retry wrapper's undefined is
 *     ok: false, and an honest empty answer is ok: true with no rows.
 *   - A QUERY THE CLAMP REFUSES MAKES NO REQUEST, and neither does an argument that
 *     is not an object. A query the API refuses (InvalidArgument) is a refusal, not
 *     an outage, and no retry runs. Every refusal says why in `error` and is logged.
 *   - KV HOLDS THE DEFAULT VIEW ONLY, AND ONLY A POPULATED ANSWER. A filter value
 *     is never a key, and an empty or failed read is never pinned for six hours.
 *     The entry is the API's answer as proto JSON, mapped again on every read.
 *   - THE ROWS ARE PLAIN. A result survives a JSON round trip unchanged.
 */

import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { create, toJson } from "@bufbuild/protobuf";

const mockRequestNotices = jest.fn();
const mockRequestRegisters = jest.fn();
const mockCreateConnectTransport = jest.fn((_options: unknown) => ({}));
const mockGetCached = jest.fn();
const mockSetCached = jest.fn();

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (options: unknown) => mockCreateConnectTransport(options),
}));

jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({
    listSubstantialNotices: (request: unknown) => mockRequestNotices(request),
    listStockRegisters: (request: unknown) => mockRequestRegisters(request),
  }),
}));

// The real codec and the real messages. The KV entry is the API's answer as
// proto JSON, so the round trip below has to run through toJson and fromJson.
jest.mock("@bufbuild/protobuf", () => jest.requireActual("@bufbuild/protobuf"));
jest.mock("~/gen/shorts/v1alpha1/ownership_pb", () =>
  jest.requireActual("~/gen/shorts/v1alpha1/ownership_pb"),
);

jest.mock("@/lib/kv-cache", () => {
  const actual = jest.requireActual("@/lib/kv-cache");
  return {
    ...actual,
    getCached: (key: string) => mockGetCached(key),
    setCached: (key: string, value: unknown, ttl: number) => mockSetCached(key, value, ttl),
  };
});

import { formatAmount } from "~/@/lib/fundamentals/format";
import {
  defaultNoticeQuery,
  defaultRegistersQuery,
  type NoticeQueryInput,
  type RegistersQueryInput,
} from "~/@/lib/ownership/query";
import {
  ListStockRegistersResponseSchema,
  ListSubstantialNoticesResponseSchema,
} from "~/gen/shorts/v1alpha1/ownership_pb";
import { CACHE_KEYS, OWNERSHIP_TTL } from "@/lib/kv-cache";
import { SERVER_SHORTS_API_URL } from "../config";
import { loadNoticeFeed, loadStockRegisters } from "../ownershipExplorer";

const originalEnv = process.env;

const UNAVAILABLE = { code: 14, message: "unavailable" };
const CURSOR = "2026-10-20|https://www.asx.com.au/notice-bhp.pdf";
const NOTICES_KEY = "cache:ownership:notices:v1";
const REGISTERS_KEY = "cache:ownership:registers:v1";

/** A notice as the API serves it: every field the mapping reads, a 603 by default. */
function notice(overrides: Record<string, unknown> = {}) {
  return {
    stockCode: "BHP",
    companyName: "BHP Group",
    holderKey: "blackrock",
    holderName: "BlackRock Investment Management",
    institutionSlug: "blackrock",
    kind: "index_manager",
    form: "603",
    event: "became",
    presentPct: 9.1,
    hasPresent: true,
    previousPct: 0,
    hasPrevious: false,
    ceased: false,
    eventDate: "2026-10-20",
    announcedOn: "2026-10-21",
    announcementUrl: "https://www.asx.com.au/notice-bhp.pdf",
    ...overrides,
  };
}

function activity(overrides: Record<string, unknown> = {}) {
  return {
    became: 1,
    increased: 0,
    decreased: 0,
    changed: 0,
    ceased: 0,
    nz: 0,
    weeks: [],
    largestRises: [],
    largestFalls: [],
    ...overrides,
  };
}

/** The feed's answer to the default view: one notice, and the activity the window owes. */
function feedResponse(overrides: Record<string, unknown> = {}) {
  return create(ListSubstantialNoticesResponseSchema, {
    notices: [notice()],
    total: 1,
    asOf: "2026-10-21",
    nextCursor: "",
    activity: activity({
      weeks: [
        { weekStart: "2026-10-19", became: 1, increased: 0, decreased: 0, changed: 0, ceased: 0, nz: 0 },
      ],
    }),
    ...overrides,
  });
}

/** A stock's register row as the API serves it: two super options, one index fund, one bank. */
function stock(overrides: Record<string, unknown> = {}) {
  return {
    stockCode: "BHP",
    companyName: "BHP Group",
    industry: "Materials",
    holders: 4,
    disclosedPct: 14.1,
    byKind: [
      { kind: "super_fund", pct: 4.5, holders: 2 },
      { kind: "index_manager", pct: 3.1, holders: 1 },
      { kind: "bank_broker", pct: 6.5, holders: 1 },
    ],
    shortPct: 4.2,
    hasShortPct: true,
    shortAsOf: "2026-10-29",
    indexPct: 6.004,
    hasIndexPct: true,
    indexAsAtFrom: "2026-09-30",
    indexAsAtTo: "2026-10-29",
    indexFiles: 3,
    superOptions: 2,
    superValueAud: 1_500_000,
    hasSuperValue: true,
    latestNoticeDate: "2026-10-20",
    ...overrides,
  };
}

function registersResponse(overrides: Record<string, unknown> = {}) {
  return create(ListStockRegistersResponseSchema, {
    stocks: [stock()],
    total: 1,
    universe: 42,
    industries: [{ industry: "Materials", stocks: 12 }],
    asOf: "2026-10-30",
    ...overrides,
  });
}

/**
 * Runs an action whose request fails with a retryable error. The retry wrapper
 * backs off between attempts, so the timers run at once rather than in real time.
 */
async function withOutage<T>(run: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  const spies = ["log", "warn", "error"].map((method) =>
    jest.spyOn(console, method as "log" | "warn" | "error").mockImplementation(() => {}),
  );
  try {
    const pending = run();
    await jest.runAllTimersAsync();
    return await pending;
  } finally {
    spies.forEach((spy) => spy.mockRestore());
    jest.useRealTimers();
  }
}

function enterBuildPrerender() {
  process.env.SKIP_STATIC_GENERATION = "1";
  process.env.NEXT_PHASE = "phase-production-build";
}

// A refusal is logged. The spy keeps the test output quiet and lets a test read the log.
let warn: jest.SpyInstance;

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv };
  delete process.env.SKIP_STATIC_GENERATION;
  delete process.env.NEXT_PHASE;
  mockGetCached.mockResolvedValue(null);
  mockSetCached.mockResolvedValue(true);
  mockRequestNotices.mockResolvedValue(feedResponse());
  mockRequestRegisters.mockResolvedValue(registersResponse());
  warn = jest.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  process.env = originalEnv;
});

describe("loadNoticeFeed", () => {
  it("answers the default view from a populated KV entry, without a request", async () => {
    const fresh = await loadNoticeFeed({});
    mockRequestNotices.mockClear();
    mockGetCached.mockResolvedValue(toJson(ListSubstantialNoticesResponseSchema, feedResponse()));

    const page = await loadNoticeFeed({});

    expect(mockGetCached).toHaveBeenLastCalledWith(NOTICES_KEY);
    expect(page).toEqual(fresh);
    expect(mockRequestNotices).not.toHaveBeenCalled();
  });

  it("keeps a populated default answer for the overview TTL, as the API's proto JSON", async () => {
    const page = await loadNoticeFeed({});

    expect(page.ok).toBe(true);
    expect(mockRequestNotices).toHaveBeenCalledTimes(1);
    expect(mockSetCached).toHaveBeenCalledWith(
      NOTICES_KEY,
      toJson(ListSubstantialNoticesResponseSchema, feedResponse()),
      OWNERSHIP_TTL,
    );
    expect(OWNERSHIP_TTL).toBe(21600);
    expect(CACHE_KEYS.ownershipNotices()).toBe(NOTICES_KEY);
  });

  it("maps the stored answer again on every read, so both reads give the same page", async () => {
    const fresh = await loadNoticeFeed({});
    const [, stored] = mockSetCached.mock.calls[0] as [string, unknown, number];
    mockRequestNotices.mockClear();
    mockGetCached.mockResolvedValue(stored);

    const read = await loadNoticeFeed({});

    expect(read).toEqual(fresh);
    expect(mockRequestNotices).not.toHaveBeenCalled();
  });

  it("never keeps an empty answer, and never keeps an outage", async () => {
    mockRequestNotices.mockResolvedValue(feedResponse({ notices: [], total: 0, activity: activity() }));
    const empty = await loadNoticeFeed({});
    expect(empty).toMatchObject({ ok: true, activityOk: true, rows: [] });
    expect(mockSetCached).not.toHaveBeenCalled();

    mockRequestNotices.mockRejectedValue(UNAVAILABLE);
    const down = await withOutage(() => loadNoticeFeed({}));
    expect(down.ok).toBe(false);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("never keeps a default answer whose activity did not come back", async () => {
    mockRequestNotices.mockResolvedValue(feedResponse({ activity: undefined }));

    const page = await loadNoticeFeed({});

    expect(page).toMatchObject({ ok: true, activityOk: false, activity: null, weeks: [] });
    expect(page.rows).toHaveLength(1);
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("reads again an entry the current proto does not parse, rather than rendering it", async () => {
    mockGetCached.mockResolvedValue({ notices: "not a list" });

    const page = await loadNoticeFeed({});

    expect(mockRequestNotices).toHaveBeenCalledTimes(1);
    expect(page.rows).toHaveLength(1);
    expect(mockSetCached).toHaveBeenCalledWith(
      NOTICES_KEY,
      toJson(ListSubstantialNoticesResponseSchema, feedResponse()),
      OWNERSHIP_TTL,
    );
  });

  it("reads again an entry that parses but holds no notice", async () => {
    mockGetCached.mockResolvedValue(
      toJson(ListSubstantialNoticesResponseSchema, feedResponse({ notices: [], total: 0 })),
    );

    const page = await loadNoticeFeed({});

    expect(mockRequestNotices).toHaveBeenCalledTimes(1);
    expect(page.rows).toHaveLength(1);
  });

  it("treats a window of 30 with no other filter as the default view, and everything else as a live read", async () => {
    await loadNoticeFeed({ windowDays: 30 });
    expect(mockGetCached).toHaveBeenCalledWith(NOTICES_KEY);
  });

  it.each<[string, NoticeQueryInput]>([
    ["a window", { windowDays: 7 }],
    ["the whole register", { windowDays: 0 }],
    ["an event", { event: "ceased" }],
    ["a kind", { kind: "bank_broker" }],
    ["a stock", { stockCode: "BHP" }],
    ["a holder", { institutionSlug: "blackrock" }],
    ["a later page", { cursor: CURSOR }],
    ["no activity", { includeActivity: false }],
  ])("reads and writes no KV entry for a view with %s", async (_label, input) => {
    await loadNoticeFeed(input);

    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockSetCached).not.toHaveBeenCalled();
    expect(mockRequestNotices).toHaveBeenCalledTimes(1);
  });

  it("forwards the industry and the dates, and sends no window or activity beside them", async () => {
    await loadNoticeFeed({ industry: "Energy", since: "2026-08-01", until: "2026-10-31" });

    expect(mockRequestNotices).toHaveBeenCalledWith({
      windowDays: 0,
      event: "",
      kind: "",
      stockCode: "",
      industry: "Energy",
      since: "2026-08-01",
      until: "2026-10-31",
      institutionSlug: "",
      cursor: "",
      limit: 50,
      includeActivity: false,
    });
  });

  it("sends the clamped query, rounding a window up and capping the page as the API does", async () => {
    const page = await loadNoticeFeed({ windowDays: 45, limit: 5000 });

    expect(mockRequestNotices).toHaveBeenCalledWith({
      windowDays: 90,
      event: "",
      kind: "",
      stockCode: "",
      industry: "",
      since: "",
      until: "",
      institutionSlug: "",
      cursor: "",
      limit: 100,
      includeActivity: true,
    });
    expect(page.query.windowDays).toBe(90);
    expect(page.query.limit).toBe(100);
  });

  it("refuses a query it cannot serve, with no request, and says why", async () => {
    const page = await loadNoticeFeed({ windowDays: -1 });

    expect(page).toMatchObject({
      ok: false,
      error: "window_days must not be negative",
      rows: [],
    });
    expect(page.query).toEqual(defaultNoticeQuery());
    expect(mockRequestNotices).not.toHaveBeenCalled();
    expect(mockGetCached).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an array", []],
    ["text", "BHP"],
  ])("refuses an argument that is %s, with no request and no KV read", async (_label, input) => {
    const page = await loadNoticeFeed(input as NoticeQueryInput);

    expect(page).toMatchObject({ ok: false, error: "the query must be an object", rows: [] });
    expect(page.query).toEqual(defaultNoticeQuery());
    expect(mockRequestNotices).not.toHaveBeenCalled();
    expect(mockGetCached).not.toHaveBeenCalled();
  });

  it("reports our outage as ok false, never as an empty feed", async () => {
    mockRequestNotices.mockRejectedValue(UNAVAILABLE);

    const page = await withOutage(() => loadNoticeFeed({}));
    expect(page).toMatchObject({
      ok: false,
      activityOk: false,
      error: "",
      rows: [],
      total: 0,
      weeks: [],
      activity: null,
    });

    // A later page owes no activity, so its outage leaves activityOk true.
    const later = await withOutage(() => loadNoticeFeed({ cursor: CURSOR }));
    expect(later).toMatchObject({ ok: false, activityOk: true });
  });

  it("reports an answer with no notices as ok, with no rows", async () => {
    mockRequestNotices.mockResolvedValue(feedResponse({ notices: [], total: 0, activity: activity() }));

    const page = await loadNoticeFeed({ windowDays: 7 });

    expect(page).toMatchObject({ ok: true, activityOk: true, rows: [], total: 0 });
  });

  it("owes its activity only on a first page of a window up to 90 days", async () => {
    mockRequestNotices.mockResolvedValue(feedResponse({ activity: undefined }));

    expect(await loadNoticeFeed({})).toMatchObject({ ok: true, activityOk: false, activity: null });
    expect(await loadNoticeFeed({ windowDays: 365 })).toMatchObject({ activityOk: true, activity: null });
    expect(await loadNoticeFeed({ windowDays: 0 })).toMatchObject({ activityOk: true, activity: null });
    expect(await loadNoticeFeed({ windowDays: 30, cursor: CURSOR })).toMatchObject({ activityOk: true });
    expect(await loadNoticeFeed({ windowDays: 30, includeActivity: false })).toMatchObject({
      activityOk: true,
    });
  });

  it("maps every notice to the island's row, one way for each event", async () => {
    mockRequestNotices.mockResolvedValue(
      feedResponse({
        notices: [
          notice(),
          notice({
            holderKey: "asx:SFR",
            holderName: "Swift TV",
            institutionSlug: "",
            kind: "corporate",
            form: "605",
            event: "ceased",
            ceased: true,
            hasPresent: false,
            presentPct: 0,
            hasPrevious: true,
            previousPct: 5.2,
            eventDate: "",
            announcedOn: "2026-10-01",
          }),
          notice({
            holderKey: "mufg",
            holderName: "MUFG Securities",
            institutionSlug: "",
            kind: "bank_broker",
            form: "604",
            event: "increased",
            presentPct: 6.14,
            hasPresent: true,
            previousPct: 5,
            hasPrevious: true,
            eventDate: "2026-10-15",
            announcedOn: "2026-10-16",
          }),
          notice({
            holderKey: "small",
            holderName: "",
            institutionSlug: "",
            kind: "other",
            form: "nz",
            event: "nz",
            presentPct: 5.01,
            hasPresent: true,
            hasPrevious: false,
            eventDate: "",
            announcedOn: "2026-10-02",
          }),
        ],
        total: 4,
      }),
    );

    const page = await loadNoticeFeed({});

    expect(page.rows).toEqual([
      {
        released: "2026-10-21",
        event: "became",
        code: "BHP",
        companyName: "BHP Group",
        holder: "BlackRock Investment Management",
        holderHref: "/ownership/blackrock",
        votingPower: "9.10%",
        change: "",
        changePp: null,
        url: "https://www.asx.com.au/notice-bhp.pdf",
      },
      {
        released: "2026-10-01",
        event: "ceased",
        code: "BHP",
        companyName: "BHP Group",
        holder: "Swift TV",
        holderHref: "/shorts/SFR/company",
        votingPower: "under 5%",
        change: "",
        changePp: null,
        url: "https://www.asx.com.au/notice-bhp.pdf",
      },
      {
        released: "2026-10-16",
        event: "increased",
        code: "BHP",
        companyName: "BHP Group",
        holder: "MUFG Securities",
        holderHref: null,
        votingPower: "6.14%",
        change: "+1.14 pp",
        changePp: 6.14 - 5,
        url: "https://www.asx.com.au/notice-bhp.pdf",
      },
      {
        released: "2026-10-02",
        event: "nz",
        code: "BHP",
        companyName: "BHP Group",
        holder: "Unnamed holder",
        holderHref: null,
        votingPower: "5.01%",
        change: "",
        changePp: null,
        url: "https://www.asx.com.au/notice-bhp.pdf",
      },
    ]);
  });

  it("carries the change in points when both figures are stated, and null when either is missing", async () => {
    mockRequestNotices.mockResolvedValue(
      feedResponse({
        notices: [
          notice({ presentPct: 3.5, hasPresent: true, previousPct: 5, hasPrevious: true }),
          notice({ presentPct: 0, hasPresent: false, previousPct: 5, hasPrevious: true }),
          notice({ presentPct: 6, hasPresent: true, previousPct: 0, hasPrevious: false }),
        ],
        total: 3,
      }),
    );

    const page = await loadNoticeFeed({});

    expect(page.rows.map((row) => row.changePp)).toEqual([-1.5, null, null]);
  });

  it("passes an event this build does not know through as the API sent it", async () => {
    mockRequestNotices.mockResolvedValue(feedResponse({ notices: [notice({ event: "withdrawn" })] }));

    const page = await loadNoticeFeed({});

    expect(page.rows[0]).toMatchObject({ event: "withdrawn" });
  });

  it("keeps the window's activity as its counts and largest moves, and its weeks as counts", async () => {
    const move = notice({
      holderKey: "mufg",
      holderName: "MUFG Securities",
      institutionSlug: "",
      kind: "bank_broker",
      form: "604",
      event: "increased",
      presentPct: 6.14,
      hasPresent: true,
      previousPct: 5,
      hasPrevious: true,
    });
    mockRequestNotices.mockResolvedValue(
      feedResponse({
        activity: activity({
          became: 1,
          changed: 2,
          weeks: [
            { weekStart: "2026-10-05", became: 1, increased: 0, decreased: 0, changed: 2, ceased: 0, nz: 0 },
            { weekStart: "2026-10-12", became: 0, increased: 0, decreased: 0, changed: 0, ceased: 0, nz: 0 },
          ],
          largestRises: [move],
          largestFalls: [],
        }),
      }),
    );

    const page = await loadNoticeFeed({});

    expect(page.weeks).toEqual([
      { weekStart: "2026-10-05", count: 3 },
      { weekStart: "2026-10-12", count: 0 },
    ]);
    expect(page.activity).toEqual({
      became: 1,
      increased: 0,
      decreased: 0,
      changed: 2,
      ceased: 0,
      nz: 0,
      largestRises: [
        {
          released: "2026-10-21",
          event: "increased",
          code: "BHP",
          companyName: "BHP Group",
          holder: "MUFG Securities",
          holderHref: null,
          votingPower: "6.14%",
          change: "+1.14 pp",
          changePp: 6.14 - 5,
          url: "https://www.asx.com.au/notice-bhp.pdf",
        },
      ],
      largestFalls: [],
    });
  });

  it("is plain data: a result survives a JSON round trip unchanged, and carries no generated message", async () => {
    const page = await loadNoticeFeed({});

    expect(JSON.parse(JSON.stringify(page))).toEqual(page);
    // toEqual ignores a message's type, so the page's own JSON is what shows a generated message.
    expect(JSON.stringify(page)).not.toContain("$typeName");
  });

  it("asks for activity only on a first page of a window it can count, so a load-more never reads activityOk false", async () => {
    mockRequestNotices.mockResolvedValue(feedResponse({ activity: undefined }));

    const more = await loadNoticeFeed({ cursor: CURSOR, includeActivity: true });
    expect(mockRequestNotices).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: CURSOR, includeActivity: false }),
    );
    expect(more).toMatchObject({ ok: true, activityOk: true, activity: null });

    await loadNoticeFeed({});
    expect(mockRequestNotices).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "", includeActivity: true }),
    );

    await loadNoticeFeed({ windowDays: 365 });
    expect(mockRequestNotices).toHaveBeenLastCalledWith(
      expect.objectContaining({ windowDays: 365, includeActivity: false }),
    );
  });

  it("logs a refused query with its reason cut to 200 characters, and keeps the whole reason in error", async () => {
    const page = await loadNoticeFeed({ kind: "x".repeat(300) });

    expect(page).toMatchObject({ ok: false, rows: [] });
    expect(page.error.length).toBeGreaterThan(200);
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = String(warn.mock.calls[0]?.[0]);
    expect(logged).toContain(page.error.slice(0, 200));
    expect(logged).not.toContain(page.error.slice(0, 201));
    expect(mockRequestNotices).not.toHaveBeenCalled();
  });

  it("maps the API's refusal of its arguments to ok false with the reason, logs it, and retries nothing", async () => {
    const reason = "event must be one of became, increased";
    mockRequestNotices.mockRejectedValue({
      code: 3,
      rawMessage: reason,
      message: `[invalid_argument] ${reason}`,
    });

    const page = await loadNoticeFeed({});

    expect(page).toMatchObject({
      ok: false,
      activityOk: false,
      error: `refused by the API: ${reason}`,
      rows: [],
    });
    expect(mockRequestNotices).toHaveBeenCalledTimes(1);
    expect(mockSetCached).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`refused by the API: ${reason}`));

    const filtered = await loadNoticeFeed({ event: "ceased" });
    expect(filtered).toMatchObject({ ok: false, error: `refused by the API: ${reason}`, rows: [] });
    expect(mockRequestNotices).toHaveBeenCalledTimes(2);
  });

  it("makes no request and reads no KV entry during the build prerender", async () => {
    enterBuildPrerender();

    const page = await loadNoticeFeed({});

    expect(page).toMatchObject({ ok: false, rows: [] });
    expect(mockRequestNotices).not.toHaveBeenCalled();
    expect(mockGetCached).not.toHaveBeenCalled();
  });

  it("sends every request through the ISR-tagged transport, which stores none of the answers (the hour and tag are the route's)", async () => {
    const fetchSpy = jest.fn().mockResolvedValue(new Response("{}"));
    const originalFetch = global.fetch;
    global.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await loadNoticeFeed({ windowDays: 7 });

      const transport = mockCreateConnectTransport.mock.calls.at(-1)?.[0] as {
        fetch: typeof fetch;
        baseUrl: string;
      };
      expect(transport.baseUrl).toBe(SERVER_SHORTS_API_URL);
      await transport.fetch(
        "https://api.shorted.com.au/shorts.v1alpha1.OwnershipService/ListSubstantialNotices",
        { method: "POST", body: "{}" },
      );

      // A POST's `next` never reaches the fetch: Next would store the answer
      // for the hour. The revalidate and the tag go to the route instead
      // (applyRoutePolicy; connect-route-policy.test.ts pins that).
      expect(fetchSpy.mock.calls[0]?.[1]).not.toHaveProperty("next");
    } finally {
      global.fetch = originalFetch;
    }
  });
});

describe("loadStockRegisters", () => {
  it("answers the default view from a populated KV entry, without a request", async () => {
    const fresh = await loadStockRegisters({});
    mockRequestRegisters.mockClear();
    mockGetCached.mockResolvedValue(toJson(ListStockRegistersResponseSchema, registersResponse()));

    const page = await loadStockRegisters({});

    expect(mockGetCached).toHaveBeenLastCalledWith(REGISTERS_KEY);
    expect(page).toEqual(fresh);
    expect(mockRequestRegisters).not.toHaveBeenCalled();
  });

  it("keeps a populated default answer under the registers key, as proto JSON, and never an empty one", async () => {
    const page = await loadStockRegisters({});

    expect(page.ok).toBe(true);
    expect(mockSetCached).toHaveBeenCalledWith(
      REGISTERS_KEY,
      toJson(ListStockRegistersResponseSchema, registersResponse()),
      OWNERSHIP_TTL,
    );

    mockSetCached.mockClear();
    mockRequestRegisters.mockResolvedValue(registersResponse({ stocks: [], total: 0 }));
    expect(await loadStockRegisters({})).toMatchObject({ ok: true, rows: [] });
    expect(mockSetCached).not.toHaveBeenCalled();
    expect(CACHE_KEYS.ownershipRegisters()).toBe(REGISTERS_KEY);
  });

  it("reads again an entry the current proto does not parse, rather than rendering it", async () => {
    mockGetCached.mockResolvedValue({ stocks: "not a list" });

    const page = await loadStockRegisters({});

    expect(mockRequestRegisters).toHaveBeenCalledTimes(1);
    expect(page.rows).toHaveLength(1);
  });

  it.each<[string, RegistersQueryInput]>([
    ["a sort", { sort: "short" }],
    ["a direction", { ascending: true }],
    ["an industry", { industry: "Materials" }],
    ["a kind", { kind: "hedge_fund" }],
    ["a minimum short position", { minShortPct: 3 }],
    ["a search", { query: "BHP" }],
    ["a later page", { offset: 50 }],
  ])("reads and writes no KV entry for a view with %s", async (_label, input) => {
    await loadStockRegisters(input);

    expect(mockGetCached).not.toHaveBeenCalled();
    expect(mockSetCached).not.toHaveBeenCalled();
    expect(mockRequestRegisters).toHaveBeenCalledTimes(1);
  });

  it("maps a register row to the island's row: the figures as strings, and each kind's bar segments", async () => {
    const page = await loadStockRegisters({});

    expect(page.rows).toEqual([
      {
        code: "BHP",
        companyName: "BHP Group",
        industry: "Materials",
        interests: "4",
        disclosed: "14.10%",
        disclosedPct: 14.1,
        byKind: [
          { kind: "super_fund", pct: 4.5, holders: 2 },
          { kind: "index_manager", pct: 3.1, holders: 1 },
          { kind: "bank_broker", pct: 6.5, holders: 1 },
        ],
        institutions: "7.60%",
        banks: "6.50%",
        hedgeActive: "0.00%",
        index: "6.00%",
        indexAsAt: "as at 2026-09-30 to 2026-10-29",
        superOptions: "2",
        superValue: formatAmount(1_500_000, "AUD"),
        short: "4.20%",
        shortAsOf: "2026-10-29",
        latestNotice: "2026-10-20",
      },
    ]);
    expect(page.universe).toBe(42);
    expect(page.industries).toEqual([{ industry: "Materials", stocks: 12 }]);
  });

  it("prints a kind nobody holds as 0.00%, the figure the API ranks it by, and n/a only for a figure a stock does not state", async () => {
    mockRequestRegisters.mockResolvedValue(
      registersResponse({
        stocks: [
          stock({
            byKind: [{ kind: "bank_broker", pct: 5.5, holders: 1 }],
            hasShortPct: false,
            shortPct: 0,
            shortAsOf: "",
            hasIndexPct: false,
            indexPct: 0,
            indexAsAtFrom: "",
            indexAsAtTo: "",
            hasSuperValue: false,
            superValueAud: 0,
            latestNoticeDate: "",
          }),
        ],
      }),
    );

    const page = await loadStockRegisters({});
    const [row] = page.rows;

    expect(row).toMatchObject({
      institutions: "0.00%",
      banks: "5.50%",
      hedgeActive: "0.00%",
      short: "n/a",
      index: "n/a",
      superValue: "n/a",
      latestNotice: "",
    });
    expect(row).not.toHaveProperty("marketCap");
    expect(row).not.toHaveProperty("indexAsAt");
    expect(row).not.toHaveProperty("shortAsOf");
  });

  it("dates each figure from the API's own dates: one date for a single file date, and none without one", async () => {
    mockRequestRegisters.mockResolvedValue(
      registersResponse({
        stocks: [
          stock({ indexAsAtFrom: "2026-10-29", indexAsAtTo: "2026-10-29", shortAsOf: "2026-10-28" }),
          stock({ stockCode: "CSL", indexAsAtFrom: "", indexAsAtTo: "", shortAsOf: "" }),
        ],
        total: 2,
      }),
    );

    const [single, undated] = (await loadStockRegisters({})).rows;

    expect(single).toMatchObject({
      index: "6.00%",
      indexAsAt: "as at 2026-10-29",
      short: "4.20%",
      shortAsOf: "2026-10-28",
    });
    expect(undated).toMatchObject({ index: "6.00%", short: "4.20%" });
    expect(undated).not.toHaveProperty("indexAsAt");
    expect(undated).not.toHaveProperty("shortAsOf");
  });

  it("sends the clamped sort, filters and page, and echoes them back", async () => {
    const page = await loadStockRegisters({
      sort: " SHORT ",
      ascending: true,
      minShortPct: 4,
      industry: " Materials ",
      minInterests: 0,
      limit: 0,
      offset: 50,
    });

    const request = {
      sort: "short",
      ascending: true,
      industry: "Materials",
      kind: "",
      minInterests: 1,
      minShortPct: 3,
      query: "",
      limit: 50,
      offset: 50,
    };
    expect(mockRequestRegisters).toHaveBeenCalledWith(request);
    expect(page.query).toEqual(request);
  });

  it("refuses an unknown sort with no request, and says why", async () => {
    const page = await loadStockRegisters({ sort: "biggest" });

    expect(page).toMatchObject({
      ok: false,
      error: expect.stringContaining("sort must be one of"),
      rows: [],
    });
    expect(page.query).toEqual(defaultRegistersQuery());
    expect(mockRequestRegisters).not.toHaveBeenCalled();
  });

  it.each<[string, unknown]>([
    ["null", null],
    ["an array", []],
    ["text", "sort"],
  ])("refuses an argument that is %s, with no request and no KV read", async (_label, input) => {
    const page = await loadStockRegisters(input as RegistersQueryInput);

    expect(page).toMatchObject({ ok: false, error: "the query must be an object", rows: [] });
    expect(page.query).toEqual(defaultRegistersQuery());
    expect(mockRequestRegisters).not.toHaveBeenCalled();
    expect(mockGetCached).not.toHaveBeenCalled();
  });

  it("reports a filter nobody matches as ok, with the universe and industries the API served", async () => {
    mockRequestRegisters.mockResolvedValue(registersResponse({ stocks: [], total: 0 }));

    const page = await loadStockRegisters({ kind: "hedge_fund", minInterests: 9 });

    expect(page).toMatchObject({
      ok: true,
      activityOk: true,
      rows: [],
      total: 0,
      universe: 42,
      industries: [{ industry: "Materials", stocks: 12 }],
    });
  });

  it("reports our outage as ok false, with nothing in it and nothing kept", async () => {
    mockRequestRegisters.mockRejectedValue(UNAVAILABLE);

    const page = await withOutage(() => loadStockRegisters({}));

    expect(page).toMatchObject({
      ok: false,
      activityOk: true,
      rows: [],
      total: 0,
      universe: 0,
      industries: [],
    });
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("makes no request and reads no KV entry during the build prerender", async () => {
    enterBuildPrerender();

    const page = await loadStockRegisters({});

    expect(page).toMatchObject({ ok: false, rows: [] });
    expect(mockRequestRegisters).not.toHaveBeenCalled();
    expect(mockGetCached).not.toHaveBeenCalled();
  });

  it("is plain data: a result survives a JSON round trip unchanged, and carries no generated message", async () => {
    const page = await loadStockRegisters({});

    expect(JSON.parse(JSON.stringify(page))).toEqual(page);
    expect(JSON.stringify(page)).not.toContain("$typeName");
  });

  it("maps the API's refusal of a register query to ok false with the reason, logs it, and retries nothing", async () => {
    const reason = "industry is not one of the register's industries";
    mockRequestRegisters.mockRejectedValue({ code: 3, rawMessage: reason, message: `[invalid_argument] ${reason}` });

    const page = await loadStockRegisters({ industry: "Mining" });

    expect(page).toMatchObject({ ok: false, error: `refused by the API: ${reason}`, rows: [] });
    expect(mockRequestRegisters).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(`refused by the API: ${reason}`));
    expect(mockSetCached).not.toHaveBeenCalled();
  });

  it("dates no figure the stock does not state: no index date without an index figure, no short date without a short figure", async () => {
    mockRequestRegisters.mockResolvedValue(
      registersResponse({
        stocks: [
          stock({
            hasIndexPct: false,
            indexAsAtFrom: "2026-09-30",
            indexAsAtTo: "2026-10-29",
            hasShortPct: false,
            shortAsOf: "2026-10-29",
          }),
        ],
      }),
    );

    const [row] = (await loadStockRegisters({})).rows;

    expect(row).toMatchObject({ index: "n/a", short: "n/a" });
    expect(row).not.toHaveProperty("indexAsAt");
    expect(row).not.toHaveProperty("shortAsOf");
  });
});

describe("the server action module", () => {
  it("is a \"use server\" file whose value exports are the two async loaders", () => {
    const file = path.join(__dirname, "..", "ownershipExplorer.ts");
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const first = source.statements[0];
    expect(first && ts.isExpressionStatement(first) && ts.isStringLiteral(first.expression)
      ? first.expression.text
      : "").toBe("use server");

    // Next accepts only async functions as exports of a "use server" file.
    // Types and interfaces are erased, so they are the only other export allowed.
    const hasModifier = (node: ts.Node, kind: ts.SyntaxKind) =>
      (ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined)?.some(
        (modifier) => modifier.kind === kind,
      ) ?? false;
    const asyncExports: string[] = [];
    const otherValueExports: string[] = [];
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (!statement.isTypeOnly) otherValueExports.push(statement.getText(source));
        continue;
      }
      if (!hasModifier(statement, ts.SyntaxKind.ExportKeyword)) continue;
      if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) continue;
      if (ts.isFunctionDeclaration(statement) && hasModifier(statement, ts.SyntaxKind.AsyncKeyword)) {
        asyncExports.push(statement.name?.text ?? "");
      } else {
        otherValueExports.push(statement.getText(source).split("\n")[0] ?? "");
      }
    }

    expect(otherValueExports).toEqual([]);
    expect(asyncExports.sort()).toEqual(["loadNoticeFeed", "loadStockRegisters"]);
  });
});
