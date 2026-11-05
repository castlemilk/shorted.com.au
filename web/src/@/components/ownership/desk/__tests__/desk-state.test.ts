/// <reference types="jest" />

/**
 * The desk's URL codec (spec 13.1). Defaults are omitted, an unknown value takes
 * its default one parameter at a time, and what the codec writes it reads back to
 * the same state. The window of days and the fund's two dates are independent.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_DESK_STATE,
  cleanDeskState,
  isIsoDate,
  DEFAULT_DESK_SORT,
  isDeskSort,
  isServedNoticePair,
  normalizeDeskState,
  readDeskSort,
  readDeskState,
  readNoticeWindow,
  shiftDate,
  windowDates,
  writeDeskParams,
  writeDeskState,
  writeNoticeWindow,
  type DeskState,
} from "../desk-state";

describe("desk state codec", () => {
  it("writes the default state as the bare path", () => {
    expect(writeDeskState(DEFAULT_DESK_STATE)).toBe("");
    expect(readDeskState(new URLSearchParams(""))).toEqual(DEFAULT_DESK_STATE);
  });

  it("omits every default and writes only what differs", () => {
    const state: DeskState = { ...DEFAULT_DESK_STATE, window: 28 };
    expect(writeDeskState(state)).toBe("window=28");
    expect(writeDeskState({ ...DEFAULT_DESK_STATE, lens: "flow" })).toBe("lens=flow");
  });

  it("reads each parameter of a link", () => {
    const state = readDeskState(new URLSearchParams("window=182&lens=short&sector=Materials"));
    expect(state).toEqual({ ...DEFAULT_DESK_STATE, window: 182, lens: "short", sector: "Materials" });
  });

  it("falls back to the default for each unknown value, one parameter at a time", () => {
    const state = readDeskState(new URLSearchParams("window=7&lens=rainbow&sector=Materials"));
    expect(state).toEqual({ ...DEFAULT_DESK_STATE, sector: "Materials" });
  });

  it("refuses a window that is not one the desk serves, even a number that is close", () => {
    for (const window of ["0", "-28", "28.5", "28d", "365", "", "9999999999999999999"]) {
      expect(readDeskState(new URLSearchParams({ window }))).toEqual(DEFAULT_DESK_STATE);
    }
  });

  it("reads a Next search-params record, taking the first of a repeated key", () => {
    const state = readDeskState({ window: ["364", "28"], lens: "hedge" });
    expect(state).toEqual({ ...DEFAULT_DESK_STATE, window: 364, lens: "hedge" });
  });

  it("trims a sector and refuses a blank, a long one or one with a control character", () => {
    expect(cleanDeskState({ sector: "  Materials  " }).sector).toBe("Materials");
    expect(cleanDeskState({ sector: "   " }).sector).toBe("");
    expect(cleanDeskState({ sector: "x".repeat(65) }).sector).toBe("");
    expect(cleanDeskState({ sector: "Mat\nerials" }).sector).toBe("");
    expect(cleanDeskState({ sector: 12 }).sector).toBe("");
  });

  it("keeps a sector with the characters industries carry, and round-trips them", () => {
    const sector = "Health Care & Social Assistance";
    const written = writeDeskState({ ...DEFAULT_DESK_STATE, sector });
    expect(written).not.toContain("&Social");
    expect(readDeskState(new URLSearchParams(written)).sector).toBe(sector);
  });

  it("keeps the window of change beside a pair of fund dates, which are a window of their own", () => {
    const state = readDeskState(new URLSearchParams("window=28&from=2026-08-01&to=2026-10-31"));
    expect(state).toEqual({ ...DEFAULT_DESK_STATE, window: 28, from: "2026-08-01", to: "2026-10-31" });
    expect(writeDeskState(state)).toBe("window=28&from=2026-08-01&to=2026-10-31");
  });

  it("drops one date alone, an inverted pair and an impossible date", () => {
    expect(readDeskState(new URLSearchParams("from=2026-08-01")).from).toBe("");
    expect(readDeskState(new URLSearchParams("from=2026-10-31&to=2026-08-01")).from).toBe("");
    expect(readDeskState(new URLSearchParams("from=2026-02-30&to=2026-03-01")).from).toBe("");
  });

  it("takes a fund pair up to the served 366 days, and reads a longer pair as no window, as the API refuses it", () => {
    expect(readDeskState(new URLSearchParams("from=2025-10-31&to=2026-10-31")).from).toBe("2025-10-31");
    expect(readDeskState(new URLSearchParams("from=2025-10-29&to=2026-10-31")).from).toBe("");
    expect(readDeskState(new URLSearchParams("from=2024-01-01&to=2026-10-31")).to).toBe("");
  });

  it("round-trips every state the codec can hold", () => {
    const states: DeskState[] = [
      DEFAULT_DESK_STATE,
      { window: 28, lens: "institutional", sector: "Financials", from: "", to: "" },
      { window: 364, lens: "flow", sector: "", from: "", to: "" },
      { window: 91, lens: "index", sector: "Energy", from: "", to: "" },
      { window: 91, lens: "short", sector: "", from: "2026-01-01", to: "2026-01-31" },
      { window: 28, lens: "flow", sector: "Energy", from: "2026-08-01", to: "2026-10-31" },
      { window: 28, lens: "disclosed", sector: "Other", from: "", to: "" },
      { ...DEFAULT_DESK_STATE, sort: "changed" },
      { ...DEFAULT_DESK_STATE, lens: "flow", sort: "changed", window: 28, sector: "Energy" },
    ];
    for (const state of states) {
      expect(readDeskState(new URLSearchParams(writeDeskState(state)))).toEqual(
        normalizeDeskState(state),
      );
    }
  });

  it("keeps the window and the fund dates apart on the same state", () => {
    const state: DeskState = { window: 28, lens: "disclosed", sector: "", from: "2026-01-01", to: "2026-01-31" };
    expect(normalizeDeskState(state).window).toBe(28);
    expect(normalizeDeskState(normalizeDeskState(state))).toEqual(normalizeDeskState(state));
  });

  it("writes a window only when it is not the default", () => {
    expect(writeDeskState({ ...DEFAULT_DESK_STATE, window: 91 })).toBe("");
    expect(writeDeskState({ ...DEFAULT_DESK_STATE, window: 182 })).toBe("window=182");
  });
});

describe("date helpers", () => {
  it("accepts only calendar dates in YYYY-MM-DD form", () => {
    expect(isIsoDate("2026-10-31")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2026-02-29")).toBe(false);
    expect(isIsoDate("2026-13-01")).toBe(false);
    expect(isIsoDate("2026-1-01")).toBe(false);
    expect(isIsoDate("31/10/2026")).toBe(false);
  });

  it("moves a date by whole days", () => {
    expect(shiftDate("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDate("2024-03-01", -1)).toBe("2024-02-29");
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("counts a window of days back from the newest notice, both ends included", () => {
    expect(windowDates(28, "2026-10-31")).toEqual({ from: "2026-10-04", to: "2026-10-31" });
    expect(windowDates(91, "2026-10-31")).toEqual({ from: "2026-08-02", to: "2026-10-31" });
    expect(windowDates(28, "")).toBeNull();
    expect(windowDates(28, "2026-02-30")).toBeNull();
  });
});

describe("the brushed notice window", () => {
  it("reads a pair of notice dates as the window of change, beside the fund dates", () => {
    const state = readDeskState(
      new URLSearchParams("since=2026-08-01&until=2026-10-31&from=2026-01-01&to=2026-01-31"),
    );
    expect(state).toMatchObject({ since: "2026-08-01", until: "2026-10-31", from: "2026-01-01", to: "2026-01-31" });
  });

  it("takes the chips' default beside a pair, and a pair beside a chip is a pair", () => {
    expect(readDeskState(new URLSearchParams("window=28&since=2026-08-01&until=2026-10-31")).window).toBe(91);
    expect(readNoticeWindow(new URLSearchParams("window=28&since=2026-08-01&until=2026-10-31"))).toEqual({
      window: 91,
      since: "2026-08-01",
      until: "2026-10-31",
    });
  });

  it("keeps the notice dates apart from the fund dates in both directions", () => {
    const notices = readDeskState(new URLSearchParams("from=2026-01-01&to=2026-01-31"));
    expect(notices.since).toBe("");
    expect(writeDeskState(notices)).toBe("from=2026-01-01&to=2026-01-31");
  });

  it("keeps the brushed pair through a fund-slider write, which rebuilds only the fund dates", () => {
    const brushed = readDeskState(new URLSearchParams("since=2026-08-01&until=2026-10-31&lens=flow"));
    const moved = readDeskState(new URLSearchParams(writeDeskState({ ...brushed, from: "2026-02-01", to: "2026-03-01" })));
    expect(moved).toMatchObject({ since: "2026-08-01", until: "2026-10-31", lens: "flow", from: "2026-02-01", to: "2026-03-01" });
  });

  it("round-trips a brushed state, and writes it as the pair alone", () => {
    const state: DeskState = { ...DEFAULT_DESK_STATE, since: "2026-06-01", until: "2026-07-15", sector: "Energy" };
    expect(writeDeskState(state)).toBe("since=2026-06-01&until=2026-07-15&sector=Energy");
    expect(readDeskState(new URLSearchParams(writeDeskState(state)))).toEqual(normalizeDeskState(state));
  });

  it("writes a chip over a brush, and keeps the lens, the sector and the fund dates", () => {
    const params = new URLSearchParams("since=2026-06-01&until=2026-07-15&lens=flow&sector=Energy&from=2026-02-01&to=2026-03-01");
    writeNoticeWindow(params, { window: 28, since: "", until: "" });
    expect(readDeskState(params)).toMatchObject({
      window: 28,
      since: "",
      until: "",
      lens: "flow",
      sector: "Energy",
      from: "2026-02-01",
      to: "2026-03-01",
    });
  });

  it("leaves a parameter it does not own where it is", () => {
    const params = new URLSearchParams("utm=x&window=182");
    writeDeskParams(params, { ...DEFAULT_DESK_STATE, lens: "short" });
    expect(params.get("utm")).toBe("x");
    expect(params.get("window")).toBeNull();
    expect(params.get("lens")).toBe("short");
  });

  it("serves a pair up to 366 days apart, measured as the API measures it, in order", () => {
    expect(isServedNoticePair("2025-10-31", "2026-10-31")).toBe(true);
    expect(isServedNoticePair("2025-10-30", "2026-10-31")).toBe(true);
    expect(isServedNoticePair("2025-10-29", "2026-10-31")).toBe(false);
    expect(isServedNoticePair("2026-10-31", "2026-10-31")).toBe(true);
    expect(isServedNoticePair("2026-10-31", "2026-10-30")).toBe(false);
    expect(isServedNoticePair("2026-02-30", "2026-03-01")).toBe(false);
  });
});

/** The shared clamps (clamps.json), the same file the Go test and the feed's clamp read. */
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, "../../../../lib/ownership/__fixtures__/clamps.json"), "utf8"),
) as {
  desk: {
    windows: Array<{ from: string; to: string; rejected?: boolean }>;
    noticeDates: Array<{ since?: string; until?: string; rejected?: boolean }>;
  };
};

// The rows that name both dates: the span rule is the same for a brush and a window.
// The rows that name one date need the newest notice, which the desk state does not read.
describe("the brushed pair against clamps.json", () => {
  for (const c of FIXTURE.desk.windows.filter((w) => w.from !== "" && w.to !== "")) {
    it(`${c.rejected ? "refuses" : "serves"} the window ${c.from} to ${c.to}`, () => {
      expect(isServedNoticePair(c.from, c.to)).toBe(!c.rejected);
    });
  }
  for (const c of FIXTURE.desk.noticeDates.filter((d) => d.since !== undefined && d.until !== undefined)) {
    it(`${c.rejected ? "refuses" : "serves"} the dates ${c.since} to ${c.until}`, () => {
      expect(isServedNoticePair(c.since!, c.until!)).toBe(!c.rejected);
    });
  }
});

describe("desk state codec: the workspace selection (spec 14.1)", () => {
  it("writes sel only when a selection is set, and reads it back", () => {
    expect(writeDeskState({ ...DEFAULT_DESK_STATE, sel: "stock:BHP" })).toBe("sel=stock%3ABHP");
    expect(readDeskState(new URLSearchParams("sel=stock%3ABHP")).sel).toBe("stock:BHP");
  });

  it("drops a selection the codec does not read, one parameter at a time", () => {
    const state = readDeskState(new URLSearchParams("sel=planet%3AMARS&window=28"));
    expect(state).toEqual({ ...DEFAULT_DESK_STATE, window: 28 });
  });

  it("writeDeskParams replaces sel with the state's value, and keeps every other parameter", () => {
    const params = new URLSearchParams("sel=stock%3ABHP&utm=1");
    writeDeskParams(params, { ...DEFAULT_DESK_STATE, lens: "flow" });
    expect(params.get("sel")).toBeNull();
    expect(params.get("utm")).toBe("1");
    expect(params.get("lens")).toBe("flow");
  });

  it("keeps another island's selection through a notice-window write", () => {
    const chips = new URLSearchParams("sel=stock%3ABHP&lens=flow");
    writeNoticeWindow(chips, { window: 28, since: "", until: "" });
    expect(chips.get("sel")).toBe("stock:BHP");
    expect(chips.get("window")).toBe("28");
    expect(chips.get("lens")).toBe("flow");

    const brush = new URLSearchParams("sel=stock%3ABHP");
    writeNoticeWindow(brush, { window: 91, since: "2026-01-01", until: "2026-02-01" });
    expect(brush.get("sel")).toBe("stock:BHP");
    expect(brush.get("since")).toBe("2026-01-01");
  });

  it("keeps a holding selection through a fund-window write", () => {
    const link = new URLSearchParams("sel=holding%3Aasx%3AA200%2FBHP");
    const next = writeDeskState({ ...readDeskState(link), from: "2026-01-01", to: "2026-02-01" });
    expect(readDeskState(new URLSearchParams(next)).sel).toBe("holding:asx:A200/BHP");
    expect(readDeskState(new URLSearchParams(next)).from).toBe("2026-01-01");
  });
});

describe("desk state codec: the sort (backlog C3)", () => {
  it("defaults to largest, which the link leaves out", () => {
    expect(DEFAULT_DESK_SORT).toBe("largest");
    expect(readDeskState(new URLSearchParams("")).sort).toBe("largest");
    expect(writeDeskState({ ...DEFAULT_DESK_STATE, sort: "largest" })).toBe("");
  });

  it("writes sort only when it is changed, and reads it back", () => {
    expect(writeDeskState({ ...DEFAULT_DESK_STATE, sort: "changed" })).toBe("sort=changed");
    expect(readDeskState(new URLSearchParams("sort=changed")).sort).toBe("changed");
  });

  it("takes the default for any other value, one parameter at a time", () => {
    for (const sort of ["Changed", "biggest", "", "changed,largest", "2"]) {
      const state = readDeskState(new URLSearchParams({ sort, lens: "flow" }));
      expect(state.sort).toBe("largest");
      expect(state.lens).toBe("flow");
    }
  });

  it("reads a sort from a Next search-params record, taking the first of a repeated key", () => {
    expect(readDeskState({ sort: ["changed", "largest"] }).sort).toBe("changed");
  });

  it("recognises the two served sorts and nothing else", () => {
    expect(isDeskSort("largest")).toBe(true);
    expect(isDeskSort("changed")).toBe(true);
    expect(isDeskSort("toString")).toBe(false);
    expect(isDeskSort(undefined)).toBe(false);
    expect(isDeskSort(1)).toBe(false);
  });

  it("names the default an instrument draws in when the link names no valid sort", () => {
    expect(readDeskSort(new URLSearchParams(""), "changed")).toBe("changed");
    expect(readDeskSort(new URLSearchParams("sort=bogus"), "changed")).toBe("changed");
    expect(readDeskSort(new URLSearchParams("sort=largest"), "changed")).toBe("largest");
    expect(readDeskSort(new URLSearchParams("sort=changed"))).toBe("changed");
    expect(readDeskSort(new URLSearchParams(""))).toBe("largest");
  });

  it("writeDeskParams replaces sort with the state's value and keeps the other parameters", () => {
    const params = new URLSearchParams("sort=changed&utm=1&lens=flow");
    writeDeskParams(params, { ...DEFAULT_DESK_STATE, lens: "flow", sort: "largest" });
    expect(params.get("sort")).toBeNull();
    expect(params.get("utm")).toBe("1");
    writeDeskParams(params, { ...DEFAULT_DESK_STATE, sort: "changed" });
    expect(params.get("sort")).toBe("changed");
  });

  it("keeps a sort through a notice-window write, which rebuilds the desk's names", () => {
    const params = new URLSearchParams("sort=changed&sel=stock%3ABHP");
    writeNoticeWindow(params, { window: 28, since: "", until: "" });
    expect(params.get("sort")).toBe("changed");
    expect(params.get("window")).toBe("28");
    expect(params.get("sel")).toBe("stock:BHP");
  });
});
