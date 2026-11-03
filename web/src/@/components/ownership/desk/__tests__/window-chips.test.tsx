/// <reference types="jest" />

/**
 * The window of change (spec 13.1, 13.4): the codec the desk's instruments read
 * and write, the chips as links, and the prose that names the window. A brushed
 * pair is `since` and `until`, never the index window's `from` and `to`.
 */

import { render, screen, within } from "@testing-library/react";

import {
  DESK_DEFAULT_WINDOW_STATE,
  WindowChips,
  WindowPhrase,
  chipForBrush,
  deskParamHref,
  noticeWindowHref,
  readNoticeWindow,
  windowPhraseText,
  writeNoticeWindow,
  type NoticeWindow,
} from "../window-chips";

describe("readNoticeWindow", () => {
  it("reads the default window when the link names none", () => {
    expect(readNoticeWindow(new URLSearchParams(""))).toEqual(DESK_DEFAULT_WINDOW_STATE);
  });

  it("reads a served chip and falls back to the default for any other count", () => {
    expect(readNoticeWindow(new URLSearchParams("window=28")).window).toBe(28);
    expect(readNoticeWindow(new URLSearchParams("window=30")).window).toBe(91);
    expect(readNoticeWindow(new URLSearchParams("window=abc")).window).toBe(91);
  });

  it("reads a brushed pair of dates, in order, and no wider than the desk serves", () => {
    expect(readNoticeWindow(new URLSearchParams("since=2026-08-01&until=2026-10-31"))).toEqual({
      window: 91,
      since: "2026-08-01",
      until: "2026-10-31",
    });
    expect(readNoticeWindow(new URLSearchParams("since=2026-10-31&until=2026-08-01")).since).toBe("");
    expect(readNoticeWindow(new URLSearchParams("since=2026-08-01")).since).toBe("");
    expect(readNoticeWindow(new URLSearchParams("since=2025-01-01&until=2026-10-31")).since).toBe("");
    expect(readNoticeWindow(new URLSearchParams("since=2026-02-30&until=2026-10-31")).since).toBe("");
  });

  it("never takes the index fund window's from and to as a brush", () => {
    const state = readNoticeWindow(new URLSearchParams("from=2026-08-01&to=2026-10-31"));
    expect(state).toEqual(DESK_DEFAULT_WINDOW_STATE);
  });
});

describe("writeNoticeWindow and noticeWindowHref", () => {
  it("writes nothing for the default window", () => {
    const params = new URLSearchParams("");
    writeNoticeWindow(params, DESK_DEFAULT_WINDOW_STATE);
    expect(params.toString()).toBe("");
  });

  it("round-trips a chip and a brush through the reader", () => {
    const chip: NoticeWindow = { window: 182, since: "", until: "" };
    const brush: NoticeWindow = { window: 91, since: "2026-06-01", until: "2026-07-15" };
    for (const state of [chip, brush]) {
      const params = new URLSearchParams();
      writeNoticeWindow(params, state);
      expect(readNoticeWindow(params)).toEqual(state);
    }
  });

  it("replaces a brush when a chip is written, and keeps the reader's other parameters", () => {
    const current = new URLSearchParams("sector=Materials&since=2026-06-01&until=2026-07-15");
    const href = noticeWindowHref("/ownership", current, { window: 28, since: "", until: "" });
    expect(href).toBe("/ownership?window=28&sector=Materials");
  });

  it("writes a sector zoom beside the window, and clears it with an empty value", () => {
    const current = new URLSearchParams("window=28");
    expect(deskParamHref("/ownership", current, { sector: "Health Care" })).toBe(
      "/ownership?window=28&sector=Health+Care",
    );
    expect(deskParamHref("/ownership", new URLSearchParams("sector=Materials"), { sector: null })).toBe(
      "/ownership",
    );
  });
});

describe("chipForBrush", () => {
  it("names the chip a brush equals when it ends on the newest notice", () => {
    expect(chipForBrush("2026-08-05", "2026-11-03", "2026-11-03")).toBe(91);
    expect(chipForBrush("2026-08-06", "2026-10-31", "2026-11-03")).toBeNull();
  });
});

describe("the window as prose", () => {
  it("names a chip, a window ending on the newest notice, and any other span", () => {
    expect(windowPhraseText({ window: 91, since: "", until: "" }, "2026-11-03")).toBe("over the last 91 days");
    expect(windowPhraseText({ window: 91, since: "2026-08-01", until: "2026-11-03" }, "2026-11-03")).toBe(
      "since 2026-08-01",
    );
    expect(windowPhraseText({ window: 91, since: "2026-08-01", until: "2026-10-31" }, "2026-11-03")).toBe(
      "from 2026-08-01 to 2026-10-31",
    );
  });

  it("prints its dates as time elements", () => {
    const { container } = render(
      <WindowPhrase state={{ window: 91, since: "2026-08-01", until: "2026-10-31" }} asOf="2026-11-03" />,
    );
    const times = Array.from(container.querySelectorAll("time")).map((el) => el.getAttribute("dateTime"));
    expect(times).toEqual(["2026-08-01", "2026-10-31"]);
    expect(container).toHaveTextContent("from 2026-08-01 to 2026-10-31");
  });
});

describe("WindowChips", () => {
  it("draws one link per served window, marks the active one, and links the others replace-only", () => {
    render(
      <WindowChips
        active={{ window: 91, since: "", until: "" }}
        hrefFor={(next) => `/ownership?window=${next.window}`}
      />,
    );
    const group = screen.getByRole("group", { name: "Window of change" });
    const chips = within(group).getAllByRole("link");
    expect(chips.map((chip) => chip.textContent)).toEqual(["28 days", "91 days", "182 days", "364 days"]);
    expect(within(group).getByRole("link", { name: "91 days" })).toHaveAttribute("aria-current", "true");
    expect(within(group).getByRole("link", { name: "28 days" })).not.toHaveAttribute("aria-current");
    expect(within(group).getByRole("link", { name: "182 days" })).toHaveAttribute("href", "/ownership?window=182");
  });

  it("marks no chip while a brush holds the window", () => {
    render(
      <WindowChips
        active={{ window: 91, since: "2026-08-01", until: "2026-10-31" }}
        hrefFor={(next) => `/ownership?window=${next.window}`}
      />,
    );
    const group = screen.getByRole("group", { name: "Window of change" });
    for (const chip of within(group).getAllByRole("link")) {
      expect(chip).not.toHaveAttribute("aria-current");
    }
  });
});
