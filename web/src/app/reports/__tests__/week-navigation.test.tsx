/// <reference types="jest" />

import { describe, expect, it } from "@jest/globals";
import { render, screen } from "@testing-library/react";
import {
  WeekNavigation,
  isoWeeksInYear,
} from "~/@/components/reports/week-navigation";

describe("isoWeeksInYear", () => {
  // A year has 53 ISO weeks when 1 Jan is a Thursday, or a Wednesday in a
  // leap year. The old hardcoded 52 made "week 1 → previous week" point at a
  // week that never existed in every one of these years.
  it.each([2015, 2020, 2026, 2032])("returns 53 for %i", (year) => {
    expect(isoWeeksInYear(year)).toBe(53);
  });

  it.each([2021, 2022, 2023, 2024, 2025])("returns 52 for %i", (year) => {
    expect(isoWeeksInYear(year)).toBe(52);
  });
});

describe("WeekNavigation", () => {
  it("links the real published neighbours, skipping unpublished gaps", () => {
    // Week 20 was never generated: the prev link from week 21 must reach
    // week 19, not blindly point at the missing week.
    render(
      <WeekNavigation
        currentSlug="2026-W21"
        availableSlugs={["2026-W22", "2026-W21", "2026-W19", "2026-W18"]}
      />,
    );

    const prev = screen.getByRole("link", { name: /Week 19, 2026/ });
    expect(prev.getAttribute("href")).toBe(
      "/reports/weekly/10-most-shorted-asx-stocks-week-19-2026",
    );

    const next = screen.getByRole("link", { name: /Week 22, 2026/ });
    expect(next.getAttribute("href")).toBe(
      "/reports/weekly/10-most-shorted-asx-stocks-week-22-2026",
    );

    expect(screen.queryByText(/Week 20, 2026/)).toBeNull();
  });

  it("omits the next link on the newest published week", () => {
    render(
      <WeekNavigation
        currentSlug="2026-W22"
        availableSlugs={["2026-W22", "2026-W21"]}
      />,
    );

    expect(screen.getByRole("link", { name: /Week 21, 2026/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Week 23, 2026/ })).toBeNull();
  });

  it("crosses the year boundary into week 53 when falling back to arithmetic", () => {
    // 2026 is a 53-week ISO year, and this slug isn't in the published list,
    // so the arithmetic fallback runs.
    render(<WeekNavigation currentSlug="2027-W01" availableSlugs={[]} />);

    const prev = screen.getByRole("link", { name: /Week 53, 2026/ });
    expect(prev.getAttribute("href")).toBe(
      "/reports/weekly/10-most-shorted-asx-stocks-week-53-2026",
    );
  });

  it("renders nothing for a malformed slug", () => {
    const { container } = render(<WeekNavigation currentSlug="not-a-week" />);
    expect(container.firstChild).toBeNull();
  });
});
