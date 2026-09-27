const unstableCache = jest.fn((callback: () => Promise<unknown>) => callback);
const createConnectTransport = jest.fn(() => ({ transport: true }));
const getStockDataRpc = jest.fn();
const createClient = jest.fn(() => ({ getStockData: getStockDataRpc }));
const serverFetchOutsideNextCache = jest.fn();
const fetchEdgeReadJson = jest.fn();

jest.mock("next/cache", () => ({
  unstable_cache: (...args: unknown[]) => unstableCache(...args),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: (...args: unknown[]) =>
    createConnectTransport(...args),
}));
jest.mock("@connectrpc/connect", () => ({
  createClient: (...args: unknown[]) => createClient(...args),
}));
jest.mock("../config", () => ({
  SHORTS_API_URL: "https://shorts.test",
  serverFetchOutsideNextCache: (...args: unknown[]) =>
    serverFetchOutsideNextCache(...args),
}));
jest.mock("../edgeRead", () => ({
  fetchEdgeReadJson: (...args: unknown[]) => fetchEdgeReadJson(...args),
}));

import {
  getDailyShortSeries,
  reportDate,
  toDailyPoints,
} from "../getDailyShortSeries";
import { getLatestShortDate } from "../getLatestShortDate";

const seconds = (iso: string) => BigInt(Date.parse(iso) / 1000);

describe("getDailyShortSeries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("asks the API for every report, not the weekly means", async () => {
    getStockDataRpc.mockResolvedValue({ points: [] });

    await getDailyShortSeries("wbt");

    expect(getStockDataRpc).toHaveBeenCalledWith({
      productCode: "WBT",
      period: "max",
      fullResolution: true,
    });
    // The edge read forwards only `period` and would serve weekly buckets.
    expect(fetchEdgeReadJson).not.toHaveBeenCalled();
    expect(unstableCache).toHaveBeenCalledWith(
      expect.any(Function),
      ["stock-daily-short-series", "WBT"],
      expect.objectContaining({
        tags: expect.arrayContaining(["shorts-data"]) as unknown,
      }),
    );
  });

  it("reduces points to dated percentages, sorted, one per date", async () => {
    getStockDataRpc.mockResolvedValue({
      points: [
        { timestamp: { seconds: seconds("2024-02-02T00:00:00Z"), nanos: 0 }, shortPosition: 8.7 },
        { timestamp: { seconds: seconds("2024-02-01T00:00:00Z"), nanos: 0 }, shortPosition: 8.9 },
        { timestamp: "2024-01-31T00:00:00Z", shortPosition: 8.5 },
        { timestamp: { seconds: seconds("2024-02-02T00:00:00Z"), nanos: 0 }, shortPosition: 8.75 },
        { timestamp: undefined, shortPosition: 1 },
        { timestamp: { seconds: 0n, nanos: 0 }, shortPosition: 1 },
        { timestamp: "2024-02-05T00:00:00Z", shortPosition: Number.NaN },
      ],
    });

    await expect(getDailyShortSeries("WBT")).resolves.toEqual([
      { date: "2024-01-31", pct: 8.5 },
      { date: "2024-02-01", pct: 8.9 },
      { date: "2024-02-02", pct: 8.75 },
    ]);
  });

  it("resolves to an empty series when the API fails", async () => {
    getStockDataRpc.mockRejectedValue(new Error("boom"));
    await expect(getDailyShortSeries("WBT")).resolves.toEqual([]);
  });

  it("dates a report at midnight UTC", () => {
    expect(reportDate({ date: "2026-09-24", pct: 1 }).toISOString()).toBe(
      "2026-09-24T00:00:00.000Z",
    );
    expect(toDailyPoints(undefined)).toEqual([]);
  });
});

describe("getLatestShortDate", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("is the last report's own date, not the Monday its week began", async () => {
    // A Thursday report. The weekly MAX series dated it Monday 21 September.
    getStockDataRpc.mockResolvedValue({
      points: [
        { timestamp: { seconds: seconds("2026-09-18T00:00:00Z"), nanos: 0 }, shortPosition: 3.07 },
        { timestamp: { seconds: seconds("2026-09-24T00:00:00Z"), nanos: 0 }, shortPosition: 3.1 },
      ],
    });
    const latest = await getLatestShortDate("WBT");
    expect(latest?.toISOString().slice(0, 10)).toBe("2026-09-24");
  });

  it("is null without a dated report", async () => {
    getStockDataRpc.mockResolvedValue({ points: [] });
    await expect(getLatestShortDate("WBT")).resolves.toBeNull();
  });
});
