import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  APPROXIMATE_CHIP,
  NOT_COMPUTABLE_BODY,
  inSampleChip,
  notComputableHeadline,
  notComputableNoLabel,
  outOfSampleLine,
  referenceSpanCopy,
  referenceUnmeasuredCopy,
  runIdentityDetail,
  runIdentityLine,
  universeLabel,
  runRequiredCopy,
  runningCopy,
  shortDate,
  tooShortCopy,
} from "../backtest-copy";
import { mapBacktestRun, mapPaperTrack } from "../map-backtest";
import { FIXTURE_RECIPE_HASH, fixturePublishedRun } from "./backtest-fixtures";

describe("the states' copy (1.7), verbatim", () => {
  it("prints the not-computable headline with the measured label", () => {
    expect(notComputableHeadline("FY2024")).toBe(
      "Not computable before FY2024. From FY2024 a test is possible only by assuming when results were known and using restated figures; it is not published.",
    );
  });

  it("prints the body that explains why a fundamentals strategy has no test", () => {
    expect(NOT_COMPUTABLE_BODY).toBe(
      "This strategy's core rules need company fundamentals. Shorted has captured them point-in-time only since November 2026, and earlier vendor figures were overwritten when restated, so a historical test would use numbers nobody had at the time.",
    );
  });

  it("prints the label-less not-computable copy with the measured share", () => {
    expect(notComputableNoLabel(41.6)).toBe(
      "Not computable: needs point-in-time fundamentals (fundamentals for 42% of the universe).",
    );
    expect(notComputableNoLabel(null)).toBe("Not computable: needs point-in-time fundamentals.");
  });

  it("prints the API's state reason for run_required, never the fundamentals sentence", () => {
    const reason = "The version has no recipe yet, so no run can be published.";
    expect(runRequiredCopy("v1", "3f9a1c2e" + "b".repeat(56), reason)).toBe(reason);
    expect(runRequiredCopy("v1", "3f9a1c2e" + "b".repeat(56), "")).toBe(
      "No completed backtest for rules v1 (3f9a1c2e) yet. It is queued; results usually appear within the hour.",
    );
  });

  it("prints the running copy from the start time, in UTC", () => {
    expect(runningCopy("2026-11-08T14:02:00Z")).toBe("Running since 14:02 UTC");
    expect(runningCopy("")).toBe("Running");
  });

  it("prints the too-short copy with the recorded counts", () => {
    const paper = mapPaperTrack({ since: "2026-11-24", sessions: 13, closedTrades: 2, tooShort: true });
    expect(tooShortCopy(paper)).toBe("Recorded since 24 Nov 2026: 13 sessions, 2 trades, too short to judge");
  });

  it("names the out-of-sample row by its judgement", () => {
    expect(outOfSampleLine(mapPaperTrack({ sessions: 15, tooShort: true }))).toBe("Out-of-sample: 3 weeks, too short to judge");
    expect(outOfSampleLine(mapPaperTrack({ sessions: 70, closedTrades: 12, tooShort: false }))).toBe("Out-of-sample (recorded)");
  });

  it("prints the approximate chip with the restated-values caveat", () => {
    expect(APPROXIMATE_CHIP).toContain("flatters results");
  });
});

describe("the honesty labels (1.8)", () => {
  it("prints the in-sample chip with the freeze date", () => {
    expect(inSampleChip("2026-10-02")).toBe("In-sample backtest · rules frozen 2 Oct 2026");
  });

  it("prints the run identity line from the run, never from a literal", () => {
    const run = mapBacktestRun(fixturePublishedRun());
    expect(run.identity).not.toBeNull();
    expect(runIdentityLine(run.identity!)).toBe("Run 6 Nov 2026 · prices to 5 Nov");
    expect(runIdentityDetail(run.identity!)).toBe(
      `rules v1 04b4e5e8 · recipe csb-r1 ${FIXTURE_RECIPE_HASH.slice(0, 8)} · engine 1.1.1 · ASIC report to 2 Nov`,
    );
  });

  it("formats a date as a day, month and year, and leaves a non-date empty", () => {
    expect(shortDate("2026-11-06")).toBe("6 Nov 2026");
    expect(shortDate("")).toBe("");
  });
});

describe("the copy keeps the house style", () => {
  const sources = [
    "backtest-copy.ts",
    "backtest-tables.ts",
    "backtest-windows.ts",
    "backtest-series.ts",
    "map-backtest.ts",
  ];
  it.each(sources)("%s has no em dash", (file) => {
    const text = readFileSync(join(__dirname, "..", file), "utf8");
    expect(text.includes("\u2014")).toBe(false);
  });
});

describe("the universe label and the reference span (golden kinds and dates)", () => {
  it("labels the universe from universe_kind, and omits it for no kind", () => {
    expect(universeLabel("asic_reported")).toBe("Universe: ASIC-reported names");
    expect(universeLabel("asx_ordinary")).toBe("Universe: ASX ordinary shares");
    expect(universeLabel("")).toBe("");
  });

  it("prints the reference span to its last measured session, or that it is not measured", () => {
    expect(referenceSpanCopy("2026-10-30")).toBe("(to 30 Oct)");
    expect(referenceUnmeasuredCopy("2026-10-30")).toBe("n/a: the reference is measured to 30 Oct");
    expect(referenceSpanCopy("")).toBe("");
  });
});
