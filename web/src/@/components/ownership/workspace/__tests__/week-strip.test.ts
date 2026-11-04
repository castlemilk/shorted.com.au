/// <reference types="jest" />

/**
 * The notices-by-week model (backlog C6): the 26 Monday-started weeks ending with the as-of's
 * week, each with its count of notice dates, and the feed page that feeds it. Nothing here
 * reads a browser or a server.
 */

import {
  noticesByWeekSection,
  readWeekNotices,
  WEEK_NOTICE_PAGES,
  weekNoticesFrom,
  weekStrip,
  weekWindow,
  WEEK_STRIP_WEEKS,
  type WeekFeedPage,
} from "../week-strip";

const EM_DASH = String.fromCharCode(0x2014);

/** The Sunday-ending link a week names: the week's Monday, then its Sunday. */
const href = (weekStart: string, weekEnd: string) => `/notices?since=${weekStart}&until=${weekEnd}`;

describe("weekWindow", () => {
  it("runs from the Monday 25 weeks before the as-of's week to the as-of", () => {
    // 2026-10-31 is a Saturday, in the week of Monday 26 October; 25 weeks back is 4 May.
    expect(weekWindow("2026-10-31")).toEqual({ since: "2026-05-04", until: "2026-10-31" });
  });

  it("is one week when the strip is one week: the Monday of the as-of's week", () => {
    expect(weekWindow("2026-10-31", 1)).toEqual({ since: "2026-10-26", until: "2026-10-31" });
  });

  it("is null for a date that is not one, or a strip of no weeks", () => {
    expect(weekWindow("")).toBeNull();
    expect(weekWindow("2026-02-30")).toBeNull();
    expect(weekWindow("2026-10-31", 0)).toBeNull();
  });
});

describe("weekStrip", () => {
  it("lists 26 weeks, oldest first, every week present and each a Monday seven days after the last", () => {
    const weeks = weekStrip([], "2026-10-31", href);
    expect(weeks).toHaveLength(WEEK_STRIP_WEEKS);
    expect(weeks[0]?.weekStart).toBe("2026-05-04");
    expect(weeks[25]?.weekStart).toBe("2026-10-26");
    for (let i = 1; i < weeks.length; i += 1) {
      const previous = Date.parse(`${weeks[i - 1]!.weekStart}T00:00:00Z`);
      const current = Date.parse(`${weeks[i]!.weekStart}T00:00:00Z`);
      expect(current - previous).toBe(7 * 86_400_000);
      expect(new Date(current).getUTCDay()).toBe(1);
    }
  });

  it("fills a quiet week with a real zero rather than leaving it out", () => {
    const weeks = weekStrip(["2026-10-20", "2026-10-21", "2026-08-03"], "2026-10-31", href);
    expect(weeks).toHaveLength(26);
    expect(weeks.find((w) => w.weekStart === "2026-10-19")?.count).toBe(2);
    expect(weeks.find((w) => w.weekStart === "2026-08-03")?.count).toBe(1);
    expect(weeks.find((w) => w.weekStart === "2026-09-07")?.count).toBe(0);
    expect(weeks.reduce((sum, w) => sum + w.count, 0)).toBe(3);
  });

  it("counts a Sunday in the week of the Monday before it", () => {
    // 2026-11-01 is a Sunday: its week starts on Monday 26 October.
    const weeks = weekStrip(["2026-11-01", "2026-10-26"], "2026-11-01", href);
    const last = weeks[weeks.length - 1];
    expect(last?.weekStart).toBe("2026-10-26");
    expect(last?.count).toBe(2);
    expect(weeks[weeks.length - 2]?.count).toBe(0);
  });

  it("counts a Monday in its own week, and the first day of the span in its first week", () => {
    const weeks = weekStrip(["2026-05-04", "2026-05-10", "2026-05-11"], "2026-10-31", href);
    expect(weeks[0]).toMatchObject({ weekStart: "2026-05-04", count: 2 });
    expect(weeks[1]).toMatchObject({ weekStart: "2026-05-11", count: 1 });
  });

  it("does not count a date outside the span, or one that is not a date", () => {
    const weeks = weekStrip(["2026-03-01", "2026-11-02", "not-a-date", "2026-02-30", ""], "2026-11-01", href);
    expect(weeks.reduce((sum, w) => sum + w.count, 0)).toBe(0);
  });

  it("links each week to its Monday and its Sunday", () => {
    const weeks = weekStrip([], "2026-10-31", href);
    expect(weeks[25]?.href).toBe("/notices?since=2026-10-26&until=2026-11-01");
    expect(weeks[0]?.href).toBe("/notices?since=2026-05-04&until=2026-05-10");
  });

  it("is 26 quiet weeks for an empty list, so a strip with no notices still has its span", () => {
    const weeks = weekStrip([], "2026-10-31", href);
    expect(weeks).toHaveLength(26);
    expect(weeks.every((w) => w.count === 0)).toBe(true);
  });

  it("is an empty list when the as-of is not a date", () => {
    expect(weekStrip(["2026-10-20"], "", href)).toEqual([]);
  });
});

describe("weekNoticesFrom", () => {
  const page = (overrides: Record<string, unknown> = {}) => ({
    ok: true,
    total: 2,
    rows: [{ released: "2026-10-20" }, { released: "2026-10-02" }],
    ...overrides,
  });

  it("is the page's release dates with the as-of, when the page answered whole", () => {
    expect(weekNoticesFrom(page(), "2026-10-31")).toEqual({ asOf: "2026-10-31", released: ["2026-10-20", "2026-10-02"] });
  });

  it("is null for a feed that did not answer, so an outage is never a quiet strip", () => {
    expect(weekNoticesFrom(page({ ok: false, total: 0, rows: [] }), "2026-10-31")).toBeNull();
    expect(weekNoticesFrom(null, "2026-10-31")).toBeNull();
    expect(weekNoticesFrom(undefined, "2026-10-31")).toBeNull();
  });

  it("is null for a page that holds fewer rows than the notices it matches", () => {
    expect(weekNoticesFrom(page({ total: 150 }), "2026-10-31")).toBeNull();
  });

  it("is null without a date to end on", () => {
    expect(weekNoticesFrom(page(), "")).toBeNull();
  });
});

describe("noticesByWeekSection", () => {
  it("is the titled strip section of 26 weeks, as data the rail draws", () => {
    const section = noticesByWeekSection({ asOf: "2026-10-31", released: ["2026-10-20"] }, href);
    expect(section).toMatchObject({ title: "Notices by week", kind: "weeks" });
    expect(section?.kind === "weeks" ? section.weeks : []).toHaveLength(26);
    expect(section?.kind === "weeks" ? section.weeks.find((w) => w.count === 1)?.weekStart : null).toBe("2026-10-19");
  });

  it("is null when the notices did not read, or the as-of is not a date", () => {
    expect(noticesByWeekSection(null, href)).toBeNull();
    expect(noticesByWeekSection({ asOf: "", released: [] }, href)).toBeNull();
  });

  it("writes no em dash in its title", () => {
    expect(noticesByWeekSection({ asOf: "2026-10-31", released: [] }, href)?.title).not.toContain(EM_DASH);
  });
});

describe("readWeekNotices (the feed read a strip needs, page by page)", () => {
  const page = (rows: string[], overrides: Partial<WeekFeedPage> = {}): WeekFeedPage => ({
    ok: true,
    total: rows.length,
    nextCursor: "",
    rows: rows.map((released) => ({ released })),
    ...overrides,
  });

  it("asks the first page with the query alone, then each next page with the cursor it was given", async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(page(["2026-10-20", "2026-10-21"], { total: 3, nextCursor: "c1" }))
      .mockResolvedValueOnce(page(["2026-10-02"], { total: 3 }));
    const query = { stockCode: "BHP", since: "2026-05-04", until: "2026-10-31" };
    const notices = await readWeekNotices(load, query, "2026-10-31");
    expect(load).toHaveBeenNthCalledWith(1, query);
    expect(load).toHaveBeenNthCalledWith(2, { ...query, cursor: "c1" });
    expect(notices).toEqual({ asOf: "2026-10-31", released: ["2026-10-20", "2026-10-21", "2026-10-02"] });
  });

  it("is the one page's dates when the first page is the last", async () => {
    const load = jest.fn().mockResolvedValue(page(["2026-10-20"]));
    const notices = await readWeekNotices(load, { institutionSlug: "vanguard" }, "2026-10-31");
    expect(load).toHaveBeenCalledTimes(1);
    expect(notices?.released).toEqual(["2026-10-20"]);
  });

  it("is null when a page did not answer, so a partial read is never drawn as a quiet span", async () => {
    const load = jest
      .fn()
      .mockResolvedValueOnce(page(["2026-10-20"], { total: 2, nextCursor: "c1" }))
      .mockResolvedValueOnce(page([], { ok: false, total: 0 }));
    expect(await readWeekNotices(load, {}, "2026-10-31")).toBeNull();
  });

  it("is null when the loader returns nothing at all", async () => {
    const load = jest.fn().mockResolvedValue(undefined);
    expect(await readWeekNotices(load, {}, "2026-10-31")).toBeNull();
  });

  it("is null when the pages run out before the last one, and makes no further request", async () => {
    const load = jest.fn().mockResolvedValue(page(["2026-10-20"], { total: 500, nextCursor: "more" }));
    expect(await readWeekNotices(load, {}, "2026-10-31")).toBeNull();
    expect(load).toHaveBeenCalledTimes(WEEK_NOTICE_PAGES);
  });

  it("is null when the rows read fall short of the total, even on the last page", async () => {
    const load = jest.fn().mockResolvedValue(page(["2026-10-20"], { total: 2 }));
    expect(await readWeekNotices(load, {}, "2026-10-31")).toBeNull();
  });

  it("is null without a date to end on, though the pages were read", async () => {
    const load = jest.fn().mockResolvedValue(page(["2026-10-20"]));
    expect(await readWeekNotices(load, {}, "")).toBeNull();
  });
});
