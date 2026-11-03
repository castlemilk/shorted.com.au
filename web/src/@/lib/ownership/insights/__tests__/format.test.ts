import { addDays, addMonths, bucketLabel, daysBetween, formatPp, formatSignedAud, formatSignedPct, sectorLabel, windowText } from "../format";

const MINUS = "−";

describe("insights formatting", () => {
  it("prints a change with its direction, a true minus, and n/a for a figure not held", () => {
    expect(formatPp(1)).toBe("+1.00 pp");
    expect(formatPp(-0.314)).toBe(`${MINUS}0.31 pp`);
    expect(formatPp(0.001)).toBe("0.00 pp");
    expect(formatPp(null)).toBe("n/a");
    expect(formatSignedAud(4e8)).toBe("+$400.0M");
    expect(formatSignedAud(-1e8)).toBe(`${MINUS}$100.0M`);
    expect(formatSignedAud(null)).toBe("n/a");
    expect(formatSignedPct(10)).toBe("+10.0%");
    expect(formatSignedPct(-3.25)).toBe(`${MINUS}3.3%`);
    expect(formatSignedPct(null)).toBe("n/a");
    for (const text of [formatPp(-1), formatSignedAud(-1e6), formatSignedPct(-1)]) {
      expect(text).not.toMatch(/-/);
    }
  });

  it("prints a placeholder industry as Other", () => {
    expect(sectorLabel("")).toBe("Other");
    expect(sectorLabel("Not Applic")).toBe("Other");
    expect(sectorLabel("Materials")).toBe("Materials");
  });

  it("walks dates in UTC days and months, holding a month's last day", () => {
    expect(daysBetween("2026-10-01", "2026-10-31")).toBe(30);
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-10-31", -1)).toBe("2026-09-30");
  });

  it("labels a bucket short, and a window as a range", () => {
    expect(bucketLabel("2026-10-05", "week")).toBe("10-05");
    expect(bucketLabel("2026-10-01", "month")).toBe("2026-10");
    expect(windowText("2026-08-03", "2026-10-31")).toBe("2026-08-03 to 2026-10-31");
    expect(windowText("2026-10-31", "2026-10-31")).toBe("2026-10-31");
    expect(windowText("", "")).toBe("n/a");
  });
});
