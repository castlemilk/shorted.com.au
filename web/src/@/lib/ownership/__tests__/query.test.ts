import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KIND_ORDER } from "../kinds";
import {
  ACTIVITY_MAX_WINDOW,
  DEFAULT_REGISTER_SORT,
  NOTICE_EVENTS,
  NOTICE_WINDOW_ALL,
  REGISTER_SORTS,
  clampNoticeQuery,
  clampRegistersQuery,
  defaultNoticeQuery,
  defaultRegistersQuery,
  isDefaultNoticeQuery,
  isDefaultRegistersQuery,
  parseNoticeParams,
  parseRegisterParams,
  registerQueryMatch,
  serialiseNoticeParams,
  serialiseRegisterParams,
  wantsActivity,
  type ClampResult,
  type NoticeQueryInput,
  type RegistersQueryInput,
} from "../query";

interface Pair {
  in: number;
  out: number;
}

interface StringPair {
  in: string;
  out: string;
}

/** The shape of __fixtures__/clamps.json, which the Go test reads too. */
interface Clamps {
  windowDays: Pair[];
  windowDaysNegative: number[];
  activityMaxWindow: number;
  limit: Pair[];
  minShortPct: Pair[];
  minInterests: Pair[];
  offset: { min: number; max: number };
  queryMaxLength: number;
  defaultRegisterSort: string;
  registerSorts: string[];
  noticeEvents: string[];
  holderKinds: string[];
  stockCode: { valid: string[]; invalid: string[] };
  cursor: { valid: string; invalid: string[] };
  normalised: {
    stockCode: StringPair[];
    event: StringPair[];
    kind: StringPair[];
    institutionSlug: StringPair[];
    sort: StringPair[];
    query: Array<{ in: string; code?: string; name?: string; rejected?: boolean }>;
  };
}

const CLAMPS = JSON.parse(
  readFileSync(resolve(__dirname, "..", "__fixtures__", "clamps.json"), "utf8"),
) as Clamps;

/** The clamped query, or a failure that carries the refusal. */
function served<T>(result: ClampResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.query;
}

const refused = (result: ClampResult<unknown>): boolean => !result.ok;

const params = (init: string): URLSearchParams => new URLSearchParams(init);

/** A request the types forbid, as a server action can receive it. */
const untyped = <T>(input: Record<string, unknown>): T => input as T;

/** Requests that are not an object of fields, as a server action can receive them. */
const NOT_REQUESTS: unknown[] = [undefined, null, "windowDays", ["windowDays"]];

/** Feed queries the page can build: each one must survive a trip through its link. */
const NOTICE_LINKS: NoticeQueryInput[] = [
  {},
  { windowDays: 0 },
  { windowDays: 7, event: "ceased" },
  { windowDays: 90, kind: "index_manager", stockCode: "bhp" },
  { windowDays: 365, event: "nz", institutionSlug: " Vanguard " },
  { stockCode: "A1", institutionSlug: "vanguard", kind: "super_fund", event: "became" },
];

/** Register queries the page can build. */
const REGISTER_LINKS: RegistersQueryInput[] = [
  {},
  { sort: "code", ascending: true },
  { sort: "short", minShortPct: 5, kind: "hedge_fund" },
  { industry: "Materials", query: " bhp ", offset: 50 },
  { sort: "latest_notice", ascending: false, industry: "Banks", minShortPct: 10 },
];

describe("the shared fixture", () => {
  it("names the same vocabularies, defaults and boundaries as the Go handlers", () => {
    // Compared as sets: the order of a vocabulary is a display choice, the members are the contract.
    const sorted = (words: readonly string[]): string[] => [...words].sort();
    expect(ACTIVITY_MAX_WINDOW).toBe(CLAMPS.activityMaxWindow);
    expect(sorted(REGISTER_SORTS)).toEqual(sorted(CLAMPS.registerSorts));
    expect(DEFAULT_REGISTER_SORT).toBe(CLAMPS.defaultRegisterSort);
    expect(sorted(NOTICE_EVENTS)).toEqual(sorted(CLAMPS.noticeEvents));
    expect(sorted(KIND_ORDER)).toEqual(sorted(CLAMPS.holderKinds));
  });
});

describe("clampNoticeQuery against the fixture", () => {
  it("serves each window the way the Go handler does", () => {
    for (const c of CLAMPS.windowDays) {
      expect({ in: c.in, out: served(clampNoticeQuery({ windowDays: c.in })).windowDays }).toEqual({
        in: c.in,
        out: c.out,
      });
    }
  });

  it("refuses a negative window rather than clamping it", () => {
    for (const days of CLAMPS.windowDaysNegative) {
      expect(refused(clampNoticeQuery({ windowDays: days }))).toBe(true);
    }
  });

  it("clamps each page limit the way the Go handler does", () => {
    for (const c of CLAMPS.limit) {
      expect({ in: c.in, out: served(clampNoticeQuery({ limit: c.in })).limit }).toEqual({
        in: c.in,
        out: c.out,
      });
    }
  });

  it("checks stock codes the way the API does", () => {
    for (const code of CLAMPS.stockCode.valid) {
      expect({ code, refused: refused(clampNoticeQuery({ stockCode: code })) }).toEqual({
        code,
        refused: false,
      });
    }
    for (const code of CLAMPS.stockCode.invalid) {
      expect({ code, refused: refused(clampNoticeQuery({ stockCode: code })) }).toEqual({
        code,
        refused: true,
      });
    }
  });

  it("checks cursors the way the API does", () => {
    expect(served(clampNoticeQuery({ cursor: CLAMPS.cursor.valid })).cursor).toBe(
      CLAMPS.cursor.valid,
    );
    for (const cursor of CLAMPS.cursor.invalid) {
      expect({ cursor, refused: refused(clampNoticeQuery({ cursor })) }).toEqual({
        cursor,
        refused: true,
      });
    }
  });

  it("trims and case-folds what a request's text becomes", () => {
    for (const c of CLAMPS.normalised.stockCode) {
      expect(served(clampNoticeQuery({ stockCode: c.in })).stockCode).toBe(c.out);
    }
    for (const c of CLAMPS.normalised.event) {
      expect(served(clampNoticeQuery({ event: c.in })).event).toBe(c.out);
    }
    for (const c of CLAMPS.normalised.kind) {
      expect(served(clampNoticeQuery({ kind: c.in })).kind).toBe(c.out);
    }
    for (const c of CLAMPS.normalised.institutionSlug) {
      expect(served(clampNoticeQuery({ institutionSlug: c.in })).institutionSlug).toBe(c.out);
    }
    for (const c of CLAMPS.normalised.sort) {
      expect(served(clampRegistersQuery({ sort: c.in })).sort).toBe(c.out);
    }
  });
});

describe("clampRegistersQuery against the fixture", () => {
  it("clamps each short position to the step the Go handler snaps it to", () => {
    for (const c of CLAMPS.minShortPct) {
      expect({
        in: c.in,
        out: served(clampRegistersQuery({ minShortPct: c.in })).minShortPct,
      }).toEqual({
        in: c.in,
        out: c.out,
      });
    }
  });

  it("counts at least one interest, as the Go handler does", () => {
    for (const c of CLAMPS.minInterests) {
      expect({
        in: c.in,
        out: served(clampRegistersQuery({ minInterests: c.in })).minInterests,
      }).toEqual({
        in: c.in,
        out: c.out,
      });
    }
  });

  it("accepts the offsets at both ends of the register and refuses one past either", () => {
    expect(refused(clampRegistersQuery({ offset: CLAMPS.offset.min }))).toBe(false);
    expect(refused(clampRegistersQuery({ offset: CLAMPS.offset.max }))).toBe(false);
    expect(refused(clampRegistersQuery({ offset: CLAMPS.offset.min - 1 }))).toBe(true);
    expect(refused(clampRegistersQuery({ offset: CLAMPS.offset.max + 1 }))).toBe(true);
  });

  it("accepts a query of the fixture's length and refuses one character more", () => {
    expect(refused(clampRegistersQuery({ query: "a".repeat(CLAMPS.queryMaxLength) }))).toBe(false);
    expect(refused(clampRegistersQuery({ query: "a".repeat(CLAMPS.queryMaxLength + 1) }))).toBe(
      true,
    );
  });

  it("reads a register query as its code prefix and name substring, and refuses what the fixture refuses", () => {
    for (const c of CLAMPS.normalised.query) {
      if (c.rejected) {
        expect(refused(clampRegistersQuery({ query: c.in }))).toBe(true);
        continue;
      }
      expect(served(clampRegistersQuery({ query: c.in })).query).toBe(c.in.trim());
      expect(registerQueryMatch(c.in)).toEqual({ codePrefix: c.code, nameSubstring: c.name });
    }
  });
});

describe("clamp defaults", () => {
  it("serves the feed's default view when a request names nothing, with its activity", () => {
    expect(served(clampNoticeQuery({}))).toEqual({
      windowDays: 30,
      event: "",
      kind: "",
      stockCode: "",
      institutionSlug: "",
      cursor: "",
      limit: 50,
      includeActivity: true,
    });
    expect(served(clampNoticeQuery({}))).toEqual(defaultNoticeQuery());
  });

  it("asks for the default view's activity, so its week bars have their data", () => {
    expect(wantsActivity(defaultNoticeQuery())).toBe(true);
  });

  it("serves a request that turns activity off with it off, which is not the default view", () => {
    const query = served(clampNoticeQuery({ includeActivity: false }));
    expect(query.includeActivity).toBe(false);
    expect(isDefaultNoticeQuery(query)).toBe(false);
  });

  it("keeps window 0 as every notice the register holds, never as the default window", () => {
    expect(served(clampNoticeQuery({ windowDays: 0 })).windowDays).toBe(0);
  });

  it("takes null as a field left out, as it takes undefined", () => {
    expect(
      served(
        clampNoticeQuery(
          untyped<NoticeQueryInput>({ event: null, windowDays: null, cursor: null }),
        ),
      ),
    ).toEqual(served(clampNoticeQuery({})));
  });

  it("gives the register its default sort, descending, one interest and no filters", () => {
    expect(served(clampRegistersQuery({}))).toEqual({
      sort: "disclosed",
      ascending: false,
      industry: "",
      kind: "",
      minInterests: 1,
      minShortPct: 0,
      query: "",
      limit: 50,
      offset: 0,
    });
    expect(served(clampRegistersQuery({}))).toEqual(defaultRegistersQuery());
  });
});

describe("requests of the wrong type", () => {
  it("refuses a feed request that is not an object, or has a field of the wrong type, and never throws", () => {
    const cases: unknown[] = [
      ...NOT_REQUESTS,
      { windowDays: "7" },
      { windowDays: 2 ** 31 },
      { event: 5 },
      { kind: {} },
      { stockCode: 5 },
      { institutionSlug: 5 },
      { cursor: 5 },
      { limit: "5" },
      { limit: 2 ** 31 },
      { includeActivity: "yes" },
    ];
    for (const input of cases) {
      const result = clampNoticeQuery(input);
      expect({ input, refused: !result.ok }).toEqual({ input, refused: true });
    }
  });

  it("refuses a register request that is not an object, or has a field of the wrong type, and never throws", () => {
    const cases: unknown[] = [
      ...NOT_REQUESTS,
      { sort: 5 },
      { kind: [] },
      { ascending: "true" },
      { minInterests: 2 ** 40 },
      { minShortPct: "5" },
      { industry: 5 },
      { query: 5 },
      { offset: "5" },
      { limit: 2 ** 31 },
    ];
    for (const input of cases) {
      const result = clampRegistersQuery(input);
      expect({ input, refused: !result.ok }).toEqual({ input, refused: true });
    }
  });

  it("reads a short position of NaN as filtering nothing, as the API does", () => {
    expect(served(clampRegistersQuery({ minShortPct: Number.NaN })).minShortPct).toBe(0);
  });
});

describe("clampNoticeQuery refusals", () => {
  it("refuses what the API refuses as InvalidArgument", () => {
    const cases: NoticeQueryInput[] = [
      { windowDays: -1 },
      { event: "traded" },
      { kind: "trust" },
      { stockCode: "BH-P" },
      { stockCode: "TOOLONG7" },
      { cursor: "2026-10-16" },
      { cursor: "2026-10-16|" },
      { cursor: "2026-02-30|x" },
      { cursor: "1999-12-31|x" },
      { cursor: "0000-01-01|x" },
      { institutionSlug: "name:smith" },
      { institutionSlug: "ASX:BHP" },
      { institutionSlug: "stocks" },
    ];
    for (const input of cases) {
      expect({ input, refused: refused(clampNoticeQuery(input)) }).toEqual({
        input,
        refused: true,
      });
    }
  });

  it("refuses a fraction rather than rounding it", () => {
    expect(refused(clampNoticeQuery({ windowDays: 7.5 }))).toBe(true);
    expect(refused(clampNoticeQuery({ limit: 1.5 }))).toBe(true);
  });

  it("reads cursor dates as calendar dates, leap days included", () => {
    expect(refused(clampNoticeQuery({ cursor: "2024-02-29|x" }))).toBe(false);
    expect(refused(clampNoticeQuery({ cursor: "2025-02-29|x" }))).toBe(true);
    expect(refused(clampNoticeQuery({ cursor: "2000-01-01|x" }))).toBe(false);
  });

  it("serves a slug of the right shape and leaves the registry to the API", () => {
    expect(served(clampNoticeQuery({ institutionSlug: "nobody" })).institutionSlug).toBe("nobody");
  });

  it("refuses a sort the register does not offer, such as a market cap column", () => {
    expect(refused(clampRegistersQuery({ sort: "market_cap" }))).toBe(true);
  });

  it("refuses a kind outside the holder kinds on the register", () => {
    expect(refused(clampRegistersQuery({ kind: "trust" }))).toBe(true);
  });

  it("counts the register query in characters, not UTF-16 units", () => {
    // Each emoji is one character but two UTF-16 units, so 24 of them are 48 units.
    expect(served(clampRegistersQuery({ query: "😀".repeat(24) })).query).toBe("😀".repeat(24));
    expect(refused(clampRegistersQuery({ query: "😀".repeat(25) }))).toBe(true);
    expect(served(clampRegistersQuery({ query: "é".repeat(24) })).query).toBe("é".repeat(24));
  });

  it("leaves the industry to the API, which knows the register's list", () => {
    expect(served(clampRegistersQuery({ industry: " Banks " })).industry).toBe("Banks");
  });
});

describe("wantsActivity", () => {
  const firstPage = served(clampNoticeQuery({ windowDays: 30, includeActivity: true }));

  it("wants activity for a first page of a window up to the activity maximum", () => {
    expect(wantsActivity({ ...firstPage, windowDays: 7 })).toBe(true);
    expect(wantsActivity({ ...firstPage, windowDays: ACTIVITY_MAX_WINDOW })).toBe(true);
  });

  it("does not want it for the whole register or a window longer than the maximum", () => {
    expect(wantsActivity({ ...firstPage, windowDays: 365 })).toBe(false);
    expect(wantsActivity({ ...firstPage, windowDays: 0 })).toBe(false);
  });

  it("never wants it on a load-more page, even when the request asks for it", () => {
    const loadMore = served(
      clampNoticeQuery({ windowDays: 30, cursor: CLAMPS.cursor.valid, includeActivity: true }),
    );
    expect(loadMore.includeActivity).toBe(true);
    expect(wantsActivity(loadMore)).toBe(false);
    expect(wantsActivity({ ...firstPage, cursor: CLAMPS.cursor.valid })).toBe(false);
  });

  it("does not want it when the request turns activity off", () => {
    expect(wantsActivity({ ...firstPage, includeActivity: false })).toBe(false);
  });
});

describe("the notice link codec", () => {
  it("reads a bare link as the default view", () => {
    expect(parseNoticeParams(params(""))).toEqual(defaultNoticeQuery());
  });

  it("writes the default view as a bare link", () => {
    expect(serialiseNoticeParams(defaultNoticeQuery()).toString()).toBe("");
  });

  it("round-trips every feed query the page can build", () => {
    for (const input of NOTICE_LINKS) {
      const query = served(clampNoticeQuery(input));
      expect(parseNoticeParams(serialiseNoticeParams(query))).toEqual(query);
    }
  });

  it("writes every notice the register holds as window all", () => {
    expect(serialiseNoticeParams(served(clampNoticeQuery({ windowDays: 0 }))).get("window")).toBe(
      "all",
    );
    expect(parseNoticeParams(params("window=all")).windowDays).toBe(0);
  });

  it("rounds a whole window up to the window the API serves, as the clamp does", () => {
    const cases: Array<[string, number]> = [
      ["0", 0],
      ["8", 30],
      ["31", 90],
      ["60", 90],
      ["91", 365],
      ["400", 0],
      ["all", 0],
    ];
    for (const [value, windowDays] of cases) {
      expect({
        value,
        windowDays: parseNoticeParams(params(`window=${value}`)).windowDays,
      }).toEqual({
        value,
        windowDays,
      });
    }
  });

  it("reads a window the link cannot name as the default window, a negative one included", () => {
    for (const value of ["soon", "", "-1", "-365", "7.5"]) {
      expect({
        value,
        windowDays: parseNoticeParams(params(`window=${value}`)).windowDays,
      }).toEqual({
        value,
        windowDays: 30,
      });
    }
  });

  it("reads a whole window above 365 as every notice, int32 or not", () => {
    for (const value of ["366", "2147483647", "2147483648", "99999999999999999999999"]) {
      expect({
        value,
        windowDays: parseNoticeParams(params(`window=${value}`)).windowDays,
      }).toEqual({
        value,
        windowDays: NOTICE_WINDOW_ALL,
      });
    }
  });

  it("reads every whole window in a link the way the clamp serves it, up to 400 days", () => {
    const disagreements: number[] = [];
    for (let days = 0; days <= 400; days += 1) {
      const fromLink = parseNoticeParams(params(`window=${days}`)).windowDays;
      if (fromLink !== served(clampNoticeQuery({ windowDays: days })).windowDays) {
        disagreements.push(days);
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("keeps each valid parameter when another is unknown", () => {
    expect(parseNoticeParams(params("event=traded&stock=bhp&window=90"))).toMatchObject({
      event: "",
      stockCode: "BHP",
      windowDays: 90,
    });
  });

  it("trims and case-folds a link's values as the API does", () => {
    expect(
      parseNoticeParams(params("event=CEASED&kind=%20Index_Manager%20&holder=%20Vanguard%20")),
    ).toMatchObject({
      event: "ceased",
      kind: "index_manager",
      institutionSlug: "vanguard",
    });
  });

  it("drops a stock code the API would refuse", () => {
    expect(parseNoticeParams(params("stock=BH-P")).stockCode).toBe("");
    expect(parseNoticeParams(params("stock=TOOLONG7")).stockCode).toBe("");
  });

  it("keeps a well-formed holder whether or not the registry holds it, for the API to check", () => {
    expect(parseNoticeParams(params("holder=nobody")).institutionSlug).toBe("nobody");
    expect(parseNoticeParams(params("holder=vanguard")).institutionSlug).toBe("vanguard");
  });

  it("never reads a reserved path segment as a holder", () => {
    expect(parseNoticeParams(params("holder=stocks")).institutionSlug).toBe("");
  });

  it("never reads a name or a listed company's key as a holder", () => {
    for (const key of ["name:smith", "asx:bhp"]) {
      expect(parseNoticeParams(params(`holder=${key}`)).institutionSlug).toBe("");
    }
  });

  it("writes the stock before the holder and nothing else", () => {
    expect(
      serialiseNoticeParams(
        served(clampNoticeQuery({ stockCode: "BHP", institutionSlug: "vanguard" })),
      ).toString(),
    ).toBe("stock=BHP&holder=vanguard");
  });

  it("builds an all-notices link with window=all, which reads back as every notice", () => {
    const link = serialiseNoticeParams({
      ...defaultNoticeQuery(),
      windowDays: NOTICE_WINDOW_ALL,
      stockCode: "BHP",
    });
    expect(link.toString()).toBe("window=all&stock=BHP");
    expect(parseNoticeParams(link).windowDays).toBe(NOTICE_WINDOW_ALL);
  });

  it("names the default view by its fields, because a cursor page serialises to the same string", () => {
    const page2 = served(clampNoticeQuery({ cursor: CLAMPS.cursor.valid }));
    expect(serialiseNoticeParams(page2).toString()).toBe("");
    expect(isDefaultNoticeQuery(page2)).toBe(false);
    expect(isDefaultNoticeQuery(defaultNoticeQuery())).toBe(true);
    expect(isDefaultNoticeQuery({ ...defaultNoticeQuery(), includeActivity: false })).toBe(false);
  });

  it("does not throw on a malformed link", () => {
    expect(() => parseNoticeParams(params("window=%ZZ&holder=%E0%A4%A&stock=%%"))).not.toThrow();
  });
});

describe("the register link codec", () => {
  it("reads a bare link as the default register", () => {
    expect(parseRegisterParams(params(""))).toEqual(served(clampRegistersQuery({})));
  });

  it("writes the default register as a bare link", () => {
    expect(serialiseRegisterParams(served(clampRegistersQuery({}))).toString()).toBe("");
  });

  it("names the default register by its fields: a later page is not the default", () => {
    expect(isDefaultRegistersQuery(defaultRegistersQuery())).toBe(true);
    expect(isDefaultRegistersQuery(served(clampRegistersQuery({ offset: 50 })))).toBe(false);
    expect(isDefaultRegistersQuery(served(clampRegistersQuery({ limit: 20 })))).toBe(false);
  });

  it("round-trips every register query the page can build", () => {
    for (const input of REGISTER_LINKS) {
      const query = served(clampRegistersQuery(input));
      expect(parseRegisterParams(serialiseRegisterParams(query))).toEqual(query);
    }
  });

  it("sorts by the key and in the direction the link names", () => {
    expect(parseRegisterParams(params("sort=Code&dir=asc"))).toMatchObject({
      sort: "code",
      ascending: true,
    });
    expect(parseRegisterParams(params("sort=market_cap"))).toMatchObject({
      sort: "disclosed",
      ascending: false,
    });
    expect(parseRegisterParams(params("dir=up")).ascending).toBe(false);
  });

  it("snaps a short position down to a step, as the API does", () => {
    expect(parseRegisterParams(params("short=4")).minShortPct).toBe(3);
    expect(parseRegisterParams(params("short=5")).minShortPct).toBe(5);
    expect(parseRegisterParams(params("short=abc")).minShortPct).toBe(0);
    expect(parseRegisterParams(params("short=1e9")).minShortPct).toBe(0);
  });

  it("drops a query over 24 characters and keeps a short one, trimmed", () => {
    expect(parseRegisterParams(params(`q=${"a".repeat(25)}`)).query).toBe("");
    expect(parseRegisterParams(params("q=%20Min%20")).query).toBe("Min");
  });

  it("reads an offset inside the register and nothing beyond it", () => {
    expect(parseRegisterParams(params("offset=100")).offset).toBe(100);
    expect(parseRegisterParams(params("offset=5001")).offset).toBe(0);
    expect(parseRegisterParams(params("offset=-5")).offset).toBe(0);
  });

  it("keeps an industry only when the page knows it", () => {
    const industries = new Set(["Banks"]);
    expect(parseRegisterParams(params("industry=Banks"), { industries }).industry).toBe("Banks");
    expect(parseRegisterParams(params("industry=Nope"), { industries }).industry).toBe("");
  });

  it("drops a kind outside the holder kinds", () => {
    expect(parseRegisterParams(params("kind=trust")).kind).toBe("");
    expect(parseRegisterParams(params("kind=bank_broker")).kind).toBe("bank_broker");
  });

  it("writes the sort, direction and filters the page can set", () => {
    expect(
      serialiseRegisterParams(
        served(clampRegistersQuery({ sort: "short", ascending: true, minShortPct: 5 })),
      ).toString(),
    ).toBe("sort=short&dir=asc&short=5");
  });
});
