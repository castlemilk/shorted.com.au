const mockGetStatus = jest.fn();

jest.mock("@connectrpc/connect", () => ({
  createClient: () => ({ getStrategyDataStatus: mockGetStatus }),
}));
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: () => ({}),
}));
// The cache keeps only an answer its function resolves with: a rejection (an
// empty or failed read) is recorded here and nothing is held.
const mockCacheOutcome = jest.fn();
jest.mock("next/cache", () => ({
  unstable_cache: (fn: () => Promise<unknown>) => async () => {
    try {
      const value = await fn();
      mockCacheOutcome("held");
      return value;
    } catch (err) {
      mockCacheOutcome("rejected");
      throw err;
    }
  },
}));
jest.mock("../../config", () => ({
  SHORTS_API_URL: "https://api.test",
  serverFetchOutsideNextCache: jest.fn(),
  skipForBuild: () => false,
}));

import { getStrategyDataStatus } from "../dataStatus";

beforeEach(() => {
  mockGetStatus.mockReset();
  mockCacheOutcome.mockClear();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("getStrategyDataStatus", () => {
  it("returns the mapped status with its ten ASIC reports in order", async () => {
    const reports = Array.from({ length: 10 }, (_, i) => ({
      reportDate: `2026-10-${String(28 - i).padStart(2, "0")}`,
      availableDate: `2026-11-0${(i % 9) + 1}`,
      rows: 1800 + i,
      complete: true,
    }));
    mockGetStatus.mockResolvedValue({
      latestSession: "2026-11-04",
      snapshotAsOf: "2026-11-04",
      asicReports: reports,
    });

    const status = await getStrategyDataStatus();

    expect(status?.asicReports).toHaveLength(10);
    expect(status?.asicReports[0]?.reportDate).toBe("2026-10-28");
    expect(status?.asicReports[9]?.rows).toBe(1809);
  });

  it("answers null, and caches nothing, when the read has no session", async () => {
    mockGetStatus.mockResolvedValue({ asicReports: [] });
    await expect(getStrategyDataStatus()).resolves.toBeNull();
    expect(mockCacheOutcome).toHaveBeenCalledWith("rejected");
    expect(mockCacheOutcome).not.toHaveBeenCalledWith("held");
  });

  it("answers null, and caches nothing, when the API call fails", async () => {
    mockGetStatus.mockRejectedValue(new Error("unavailable"));
    await expect(getStrategyDataStatus()).resolves.toBeNull();
    expect(mockCacheOutcome).toHaveBeenCalledWith("rejected");
    expect(mockCacheOutcome).not.toHaveBeenCalledWith("held");
  });

  it("holds a good answer in the cache", async () => {
    mockGetStatus.mockResolvedValue({
      latestSession: "2026-11-04",
      snapshotAsOf: "2026-11-04",
      asicReports: [],
    });
    await getStrategyDataStatus();
    expect(mockCacheOutcome).toHaveBeenCalledWith("held");
  });
});
