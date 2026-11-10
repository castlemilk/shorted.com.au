/// <reference types="jest" />
import {
  SHORTS_DATA_CACHE_TAG,
  SHORTS_LATEST_CACHE_TAG,
  shortsLatestCacheTags,
  stockCodeCacheTag,
  stockPageCacheTags,
  toNextDataCacheValue,
} from "../stockPageCache";

describe("stock page cache helpers", () => {
  it("returns JSON-serializable values for protobuf-shaped stock data", () => {
    const value = toNextDataCacheValue({
      productCode: "LOT",
      points: [
        {
          timestamp: { seconds: BigInt(1_700_000_000), nanos: 0 },
          shortPosition: 12.34,
        },
      ],
      nested: {
        employeeCount: BigInt(1234),
      },
    });

    expect(JSON.stringify(value)).toContain('"productCode":"LOT"');
    expect(value.points[0].timestamp.seconds).toBe(1_700_000_000);
    expect(value.nested.employeeCount).toBe(1234);
  });

  it("names one tag per stock, whatever case or padding the code arrives in", () => {
    expect(stockCodeCacheTag("bhp")).toBe("stock:BHP");
    expect(stockCodeCacheTag(" BHP ")).toBe("stock:BHP");
  });

  it("tags a per-stock read broad, by its stock and by its kind", () => {
    expect(stockPageCacheTags("stock-data", "Bhp", "1Y")).toEqual([
      "shorts-data",
      "stock:BHP",
      "stock-page:stock-data:bhp:1y",
    ]);
  });

  it("tags a newest-snapshot read broad and shorts-latest, once each", () => {
    expect(shortsLatestCacheTags()).toEqual([SHORTS_DATA_CACHE_TAG, SHORTS_LATEST_CACHE_TAG]);
    expect(shortsLatestCacheTags("theme-snapshot", SHORTS_LATEST_CACHE_TAG)).toEqual([
      "shorts-data",
      "shorts-latest",
      "theme-snapshot",
    ]);
  });
});
