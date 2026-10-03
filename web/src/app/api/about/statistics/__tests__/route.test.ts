import { GET } from "../route";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import { CACHE_KEYS, getCached, setCached } from "~/@/lib/kv-cache";

jest.mock("~/app/actions/getTopShorts", () => ({ getTopShortsData: jest.fn() }));
jest.mock("~/@/lib/kv-cache", () => ({
  CACHE_KEYS: { statistics: "statistics" },
  getCached: jest.fn(),
  setCached: jest.fn(),
}));
jest.mock("next/server", () => ({
  NextResponse: {
    json: jest.fn((data: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: { get: (name: string) => init?.headers?.[name] ?? null },
      json: async () => data,
    })),
  },
}));

const mockGetTopShortsData = getTopShortsData as jest.MockedFunction<typeof getTopShortsData>;
const mockGetCached = getCached as jest.MockedFunction<typeof getCached>;
const mockSetCached = setCached as jest.MockedFunction<typeof setCached>;
const cached = { companyCount: 100, industryCount: 20, latestUpdateDate: "2026-10-02T00:00:00.000Z" };

describe("About statistics cache behavior", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    mockSetCached.mockResolvedValue(undefined);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it("serves concurrent valid cache hits without backend refreshes, cache writes or timers", async () => {
    mockGetCached.mockResolvedValue(cached);
    mockGetTopShortsData.mockRejectedValue(new Error("backend unavailable"));

    const responses = await Promise.all(Array.from({ length: 4 }, () => GET()));

    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Cache")).toBe("HIT");
      expect(response.headers.get("Cache-Control")).toBe("public, s-maxage=300, stale-while-revalidate=3600");
      expect(await response.json()).toEqual({ ...cached, latestUpdateDate: new Date(cached.latestUpdateDate) });
    }
    expect(mockGetTopShortsData).not.toHaveBeenCalled();
    expect(mockSetCached).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("refreshes a missing cache and clears the existing fetch timeout", async () => {
    mockGetCached.mockResolvedValue(null);
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [
        { productCode: "BHP", points: [{ timestamp: { seconds: BigInt(1_759_363_200), nanos: 0 } }] },
        { productCode: "CBA", points: [] },
      ],
      offset: 0,
    } as Awaited<ReturnType<typeof getTopShortsData>>);

    const response = await GET();
    const data = await response.json() as { companyCount: number; industryCount: number; latestUpdateDate: Date };

    expect(response.headers.get("X-Cache")).toBe("MISS");
    expect(data.companyCount).toBe(2);
    expect(data.industryCount).toBe(20);
    expect(mockGetTopShortsData).toHaveBeenCalledTimes(1);
    expect(mockSetCached).toHaveBeenCalledWith(CACHE_KEYS.statistics, {
      companyCount: 2, industryCount: 20, latestUpdateDate: data.latestUpdateDate.toISOString(),
    }, 300);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("does not overwrite a last-good snapshot when a backend fetch fails", async () => {
    // An expiry/miss can race another request's successful cache refresh.
    let stored: typeof cached | null = cached;
    mockGetCached.mockResolvedValue(null);
    mockSetCached.mockImplementation(async (_key, value) => { stored = value as typeof cached; });
    mockGetTopShortsData.mockRejectedValue(new Error("backend unavailable"));

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ companyCount: 0, industryCount: 0, latestUpdateDate: null });
    expect(mockSetCached).not.toHaveBeenCalled();
    expect(stored).toEqual(cached);
    expect(jest.getTimerCount()).toBe(0);
  });
});
