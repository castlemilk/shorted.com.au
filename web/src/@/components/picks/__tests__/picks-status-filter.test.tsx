import { render, screen, within } from "@testing-library/react";

import { PicksStatusFilter } from "../picks-status-filter";
import { PICKS, SETUP, TRIGGERED, WATCH, ZANGER, pick } from "./fixtures";

let searchParams = new URLSearchParams("");

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

const RULES = ZANGER.rules.map((rule) => ({ id: rule.id, title: rule.title }));

function renderFilter(rows = PICKS.picks, totalCount = rows.length) {
  return render(
    <PicksStatusFilter
      rows={rows}
      totalCount={totalCount}
      rules={RULES}
      basePath="/picks/zanger-breakout"
      caption="Zanger Breakout Strategy: ranked ASX picks"
    />,
  );
}

function tableCodes(): string[] {
  const table = screen.getByRole("table");
  return within(table)
    .queryAllByRole("link")
    .map((link) => link.textContent ?? "");
}

describe("PicksStatusFilter", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("");
  });

  it("shows only the filtered status", () => {
    searchParams = new URLSearchParams("status=setup");
    renderFilter();

    expect(tableCodes()).toEqual([SETUP.code]);
    expect(screen.getByRole("link", { name: /^Setup/ })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("link", { name: "Shortlist" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("filters to triggered and to watch", () => {
    searchParams = new URLSearchParams("status=triggered");
    const { unmount } = renderFilter();
    expect(tableCodes()).toEqual([TRIGGERED.code]);
    unmount();

    searchParams = new URLSearchParams("status=watch");
    renderFilter();
    expect(tableCodes()).toEqual([WATCH.code]);
  });

  it("treats a missing or unrecognised status as the shortlist", () => {
    searchParams = new URLSearchParams("status=everything");
    renderFilter();
    // Under 20 triggered + setup rows, so the watch row fills the shortlist.
    expect(tableCodes()).toEqual([TRIGGERED.code, SETUP.code, WATCH.code]);
    expect(screen.getByRole("link", { name: "Shortlist" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("keeps watch rows out of a shortlist that is already full", () => {
    const setups = Array.from({ length: 20 }, (_, i) =>
      pick({ code: `S${String(i).padStart(2, "0")}`, rank: i + 1, status: "setup" }),
    );
    renderFilter([...setups, { ...WATCH, rank: 21 }]);
    const codes = tableCodes();
    expect(codes).toHaveLength(20);
    expect(codes).not.toContain(WATCH.code);
  });

  it("says so, rather than rendering an empty table, when a status has no rows", () => {
    searchParams = new URLSearchParams("status=triggered");
    renderFilter([SETUP, WATCH]);
    expect(
      screen.getByText("No stocks are at triggered status today."),
    ).toBeInTheDocument();
  });

  it("links every chip to a URL and marks counts cut off by the row limit", () => {
    renderFilter([TRIGGERED, SETUP], 250);
    const nav = screen.getByRole("navigation", { name: "Filter picks by status" });
    expect(
      within(nav)
        .getAllByRole("link")
        .map((a) => a.getAttribute("href")),
    ).toEqual([
      "/picks/zanger-breakout",
      "/picks/zanger-breakout?status=triggered",
      "/picks/zanger-breakout?status=setup",
      "/picks/zanger-breakout?status=watch",
    ]);
    // Rows are ranked status first: triggered is complete, setup (the last
    // fetched status) and watch are floors.
    expect(within(nav).getByRole("link", { name: /^Triggered/ })).toHaveTextContent("Triggered1");
    expect(within(nav).getByRole("link", { name: /^Setup/ })).toHaveTextContent("Setup1+");
    for (const chip of within(nav).getAllByRole("link")) {
      expect(chip).toHaveAttribute("rel", "nofollow");
    }
  });
});
