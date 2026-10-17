import {
  DROPS_STALE_AFTER_HOURS,
  STATE_COVERAGE_RANK_THRESHOLD,
  dropsFreshness,
  stateCoverage,
  timestampToDate,
} from "./drops-freshness";

const ts = (iso: string) => ({
  seconds: BigInt(Math.floor(Date.parse(iso) / 1000)),
  nanos: 0,
});
const NOW = new Date("2026-09-24T00:00:00Z");

describe("timestampToDate", () => {
  it("reads protobuf-es bigint seconds", () => {
    expect(timestampToDate(ts("2026-09-15T01:46:00Z"))?.toISOString()).toBe(
      "2026-09-15T01:46:00.000Z",
    );
  });

  it("treats unset or zero stamps as unknown", () => {
    expect(timestampToDate(undefined)).toBeUndefined();
    expect(timestampToDate({ seconds: BigInt(0) })).toBeUndefined();
  });
});

describe("dropsFreshness", () => {
  it("labels the data date in Sydney time and flags a frozen crawl", () => {
    const f = dropsFreshness(
      {
        asOf: ts("2026-09-15T02:00:00Z"),
        dataThrough: ts("2026-09-15T01:46:00Z"),
      },
      NOW,
    );
    expect(f.dataToLabel).toBe("Data to 15 Sep 2026");
    expect(f.stale).toBe(true);
    expect(f.asOfIso).toBe("2026-09-15T02:00:00.000Z");
  });

  it("is not stale inside the window", () => {
    const recent = new Date(
      NOW.getTime() - (DROPS_STALE_AFTER_HOURS - 1) * 3_600_000,
    ).toISOString();
    expect(
      dropsFreshness({ asOf: ts(recent), dataThrough: ts(recent) }, NOW).stale,
    ).toBe(false);
  });

  it("flags stale when EITHER stamp is old — a refresh over frozen crawl data is still stale", () => {
    const f = dropsFreshness(
      {
        asOf: ts("2026-09-23T20:00:00Z"),
        dataThrough: ts("2026-09-15T01:46:00Z"),
      },
      NOW,
    );
    expect(f.stale).toBe(true);
  });

  it("dates nothing and flags nothing when no stamp is known", () => {
    expect(dropsFreshness({}, NOW)).toEqual({
      asOfIso: undefined,
      dataThroughIso: undefined,
      dataToLabel: undefined,
      stale: false,
    });
  });
});

describe("stateCoverage", () => {
  it("ranks a state at or above the index's coverage threshold", () => {
    expect(STATE_COVERAGE_RANK_THRESHOLD).toBe(0.6);
    expect(
      stateCoverage({ suburbsSwept14d: 101, catalogSuburbs: 135 }).ranked,
    ).toBe(true);
    expect(
      stateCoverage({ suburbsSwept14d: 81, catalogSuburbs: 135 }).ranked,
    ).toBe(true);
  });

  it("does not rank a barely-swept state", () => {
    const c = stateCoverage({ suburbsSwept14d: 3, catalogSuburbs: 67 });
    expect(c.ranked).toBe(false);
    expect(c.ratio).toBeCloseTo(3 / 67);
  });

  it("keeps ranking when coverage is unknown rather than greying out every state", () => {
    expect(stateCoverage({ suburbsSwept14d: 0, catalogSuburbs: 0 })).toEqual({
      ranked: true,
    });
  });
});
