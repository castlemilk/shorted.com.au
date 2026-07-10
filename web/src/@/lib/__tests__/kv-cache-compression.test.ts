/**
 * Round-trip tests for the large-value compression layer. The biggest cached
 * payloads (top-shorts proto JSON, megabytes of repetitive structure) filled
 * the shared Redis instance to maxmemory; values over the threshold are now
 * gzip+base64'd before SETEX.
 */
import {
  deserializeCacheValue,
  serializeCacheValue,
} from "../kv-cache";

describe("kv-cache value compression", () => {
  it("keeps small values as plain JSON", () => {
    const value = { a: 1, b: "two", nested: { c: [3, 4] } };
    const raw = serializeCacheValue(value);
    expect(raw.startsWith("gz64:")).toBe(false);
    expect(JSON.parse(raw)).toEqual(value);
    expect(deserializeCacheValue(raw)).toEqual(value);
  });

  it("compresses large values and round-trips them", () => {
    // Shaped like the top-shorts payload: repetitive objects with $typeName
    // fields and stringified timestamps.
    const big = {
      timeSeries: Array.from({ length: 500 }, (_, i) => ({
        $typeName: "stocks.v1alpha1.TimeSeriesData",
        productCode: `ST${i}`,
        points: Array.from({ length: 60 }, (_, j) => ({
          $typeName: "stocks.v1alpha1.TimeSeriesPoint",
          shortPosition: (i * j) % 25,
          timestamp: { seconds: String(1720051200 + j * 86400), nanos: 0 },
        })),
      })),
    };
    const json = JSON.stringify(big);
    const raw = serializeCacheValue(big);

    expect(raw.startsWith("gz64:")).toBe(true);
    // The whole point: an order-of-magnitude smaller at rest.
    expect(raw.length).toBeLessThan(json.length / 5);
    expect(deserializeCacheValue(raw)).toEqual(big);
  });

  it("serializes BigInt fields as strings before compressing", () => {
    const value = {
      big: 123456789012345678901234567890n,
      small: 7n,
      plain: 1,
    };
    expect(deserializeCacheValue(serializeCacheValue(value))).toEqual({
      big: "123456789012345678901234567890",
      small: "7",
      plain: 1,
    });
  });

  it("still reads legacy uncompressed entries", () => {
    const legacy = JSON.stringify({ cachedBefore: "the deploy" });
    expect(deserializeCacheValue(legacy)).toEqual({
      cachedBefore: "the deploy",
    });
  });
});
