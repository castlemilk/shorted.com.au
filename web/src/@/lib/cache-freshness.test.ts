import {
  MAX_SHORTS_DATA_AGE_DAYS,
  isCachedShortsDataStale,
  newestSeriesTimestampMs,
  timestampToMs,
} from "./cache-freshness";

const DAY = 86_400_000;
const NOW = Date.parse("2026-08-21T00:00:00.000Z");

const seriesAt = (iso: string) => [
  { productCode: "BHP", points: [{ timestamp: iso, shortPosition: 1 }] },
];

describe("timestampToMs", () => {
  it("reads an ISO string", () => {
    expect(timestampToMs("2026-08-14T00:00:00.000Z")).toBe(
      Date.parse("2026-08-14T00:00:00.000Z"),
    );
  });

  it("reads a protobuf Timestamp with seconds as string, number or bigint", () => {
    const seconds = Date.parse("2026-08-14T00:00:00.000Z") / 1000;
    const expected = seconds * 1000;
    expect(timestampToMs({ seconds: String(seconds), nanos: 0 })).toBe(expected);
    expect(timestampToMs({ seconds, nanos: 0 })).toBe(expected);
    expect(timestampToMs({ seconds: BigInt(seconds) })).toBe(expected);
  });

  it("reads a Date", () => {
    const date = new Date("2026-08-14T00:00:00.000Z");
    expect(timestampToMs(date)).toBe(date.getTime());
  });

  it("returns null for junk", () => {
    expect(timestampToMs(undefined)).toBeNull();
    expect(timestampToMs("not-a-date")).toBeNull();
    expect(timestampToMs({ seconds: 0 })).toBeNull();
    expect(timestampToMs(42)).toBeNull();
  });
});

describe("newestSeriesTimestampMs", () => {
  it("takes the maximum across every series and point, regardless of order", () => {
    const newest = newestSeriesTimestampMs([
      { points: [{ timestamp: "2026-08-10T00:00:00.000Z" }] },
      {
        points: [
          { timestamp: "2026-08-14T00:00:00.000Z" },
          { timestamp: "2026-08-12T00:00:00.000Z" },
        ],
      },
    ]);
    expect(newest).toBe(Date.parse("2026-08-14T00:00:00.000Z"));
  });

  it("is null when nothing carries a usable date", () => {
    expect(newestSeriesTimestampMs([])).toBeNull();
    expect(newestSeriesTimestampMs([{ points: [] }])).toBeNull();
    expect(newestSeriesTimestampMs([{ points: [{}] }])).toBeNull();
    expect(newestSeriesTimestampMs(null)).toBeNull();
  });
});

describe("isCachedShortsDataStale", () => {
  it("accepts a normal T+4 entry", () => {
    // Fri 14 Aug data read on Fri 21 Aug — 7 calendar days, inside the bound.
    expect(isCachedShortsDataStale(seriesAt("2026-08-14T00:00:00.000Z"), NOW)).toBe(
      false,
    );
  });

  it("accepts an entry exactly at the bound", () => {
    const atBound = new Date(NOW - MAX_SHORTS_DATA_AGE_DAYS * DAY).toISOString();
    expect(isCachedShortsDataStale(seriesAt(atBound), NOW)).toBe(false);
  });

  // The 2026-08-21 read-only-cache freeze: an entry that can no longer be
  // deleted or overwritten must stop being served on its own.
  it("rejects a frozen entry one day past the bound", () => {
    const past = new Date(NOW - (MAX_SHORTS_DATA_AGE_DAYS + 1) * DAY).toISOString();
    expect(isCachedShortsDataStale(seriesAt(past), NOW)).toBe(true);
  });

  it("rejects a frozen protobuf-shaped entry too", () => {
    const seconds = (NOW - 30 * DAY) / 1000;
    expect(
      isCachedShortsDataStale([{ points: [{ timestamp: { seconds } }] }], NOW),
    ).toBe(true);
  });

  it("does not report dateless payloads stale (structural checks own those)", () => {
    expect(isCachedShortsDataStale([{ points: [] }], NOW)).toBe(false);
    expect(isCachedShortsDataStale(undefined, NOW)).toBe(false);
  });
});
