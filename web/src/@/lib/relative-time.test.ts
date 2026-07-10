import { formatRelativeTime } from "./relative-time";

// Fixed reference "now" — mid-month noon UTC so the absolute-date branch
// renders the same calendar day across CI (UTC) and local (AEST) timezones.
// March, not June/July: en-AU CLDR leaves those two months unabbreviated
// under { month: "short" } ("8 July"), which would make assertions
// ICU-version-dependent.
const NOW = new Date("2026-03-15T12:00:00Z");

const minutesAgo = (n: number) => new Date(NOW.getTime() - n * 60_000);
const hoursAgo = (n: number) => new Date(NOW.getTime() - n * 3_600_000);
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("formatRelativeTime", () => {
  it("returns empty string for invalid dates", () => {
    expect(formatRelativeTime(new Date("not a date"), NOW)).toBe("");
  });

  it("returns 'just now' for under a minute (and future dates)", () => {
    expect(formatRelativeTime(new Date(NOW.getTime() - 30_000), NOW)).toBe(
      "just now",
    );
    expect(formatRelativeTime(new Date(NOW.getTime() + 60_000), NOW)).toBe(
      "just now",
    );
  });

  it("formats minutes granularity under an hour", () => {
    expect(formatRelativeTime(minutesAgo(1), NOW)).toBe("1m ago");
    expect(formatRelativeTime(minutesAgo(12), NOW)).toBe("12m ago");
    expect(formatRelativeTime(minutesAgo(59), NOW)).toBe("59m ago");
  });

  it("formats hours granularity under a day", () => {
    expect(formatRelativeTime(minutesAgo(60), NOW)).toBe("1h ago");
    expect(formatRelativeTime(hoursAgo(5), NOW)).toBe("5h ago");
    expect(formatRelativeTime(hoursAgo(23), NOW)).toBe("23h ago");
  });

  it("formats days granularity under a week", () => {
    expect(formatRelativeTime(hoursAgo(24), NOW)).toBe("1d ago");
    expect(formatRelativeTime(daysAgo(3), NOW)).toBe("3d ago");
    expect(formatRelativeTime(daysAgo(6), NOW)).toBe("6d ago");
  });

  it("falls back to an en-AU short date at a week or older", () => {
    expect(formatRelativeTime(daysAgo(7), NOW)).toBe("8 Mar");
    expect(formatRelativeTime(new Date("2026-01-09T12:00:00Z"), NOW)).toBe(
      "9 Jan",
    );
  });

  it("defaults `now` to the current time", () => {
    expect(formatRelativeTime(new Date(Date.now() - 5 * 60_000))).toBe(
      "5m ago",
    );
  });
});
