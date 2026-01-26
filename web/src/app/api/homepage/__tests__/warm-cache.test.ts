import { getTopShortsData } from "~/app/actions/getTopShorts";
import { getIndustryTreeMap } from "~/app/actions/getIndustryTreeMap";

// Mock ViewMode enum
const ViewMode = {
  CURRENT_CHANGE: 1,
} as const;

// Import GET after mocks are set up
let GET: any;

// Mock the server actions
jest.mock("~/app/actions/getTopShorts", () => ({
  getTopShortsData: jest.fn(),
}));

jest.mock("~/app/actions/getIndustryTreeMap", () => ({
  getIndustryTreeMap: jest.fn(),
}));

// Mock protobuf to avoid import issues
jest.mock("~/gen/shorts/v1alpha1/shorts_pb", () => ({
  ViewMode: {
    CURRENT_CHANGE: 1,
  },
}));

// Mock NextRequest
jest.mock("next/server", () => ({
  NextRequest: jest.fn().mockImplementation((url: string) => ({
    nextUrl: {
      searchParams: {
        get: jest.fn((key: string) => {
          const urlObj = new URL(url);
          return urlObj.searchParams.get(key);
        }),
      },
    },
  })),
  NextResponse: {
    json: jest.fn((data: any, init?: any) => ({
      status: init?.status ?? 200,
      json: jest.fn().mockResolvedValue(data),
    })),
  },
}));

const mockGetTopShortsData = getTopShortsData as jest.MockedFunction<
  typeof getTopShortsData
>;
const mockGetIndustryTreeMap = getIndustryTreeMap as jest.MockedFunction<
  typeof getIndustryTreeMap
>;

describe("Homepage Cache Warming Endpoint", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    process.env.CACHE_WARM_SECRET = undefined; // Clear secret for most tests
    
    // Dynamically import GET after mocks
    const route = await import("../warm-cache/route");
    GET = route.GET;
  });

  afterEach(() => {
    delete process.env.CACHE_WARM_SECRET;
  });

  it("should warm cache successfully", async () => {
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [],
      offset: 0,
    } as any);
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    const request = {
      nextUrl: {
        searchParams: {
          get: jest.fn().mockReturnValue(null),
        },
      },
    } as any;
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.results["top-shorts-3m"].success).toBe(true);
    expect(data.results["treemap-3m"].success).toBe(true);
  });

  it("should warm cache for multiple periods", async () => {
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [],
      offset: 0,
    } as any);
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    const request = {
      nextUrl: {
        searchParams: {
          get: jest.fn().mockReturnValue(null),
        },
      },
    } as any;
    const response = await GET(request);
    const data = await response.json();

    expect(data.results).toHaveProperty("top-shorts-1m");
    expect(data.results).toHaveProperty("top-shorts-6m");
    expect(data.results).toHaveProperty("top-shorts-1y");
  });

  it("should handle errors gracefully", async () => {
    mockGetTopShortsData.mockRejectedValue(new Error("API error"));
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    const request = {
      nextUrl: {
        searchParams: {
          get: jest.fn().mockReturnValue(null),
        },
      },
    } as any;
    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200); // Still 200, but with error in results
    expect(data.results["top-shorts-3m"].success).toBe(false);
    expect(data.results["top-shorts-3m"].error).toBe("API error");
    expect(data.results["treemap-3m"].success).toBe(true);
  });

  it("should require secret when CACHE_WARM_SECRET is set", async () => {
    process.env.CACHE_WARM_SECRET = "test-secret";

    const request = {
      nextUrl: {
        searchParams: {
          get: jest.fn().mockReturnValue(null),
        },
      },
    } as any;
    const response = await GET(request);

    expect(response.status).toBe(401);
    const data = await response.json();
    expect(data.error).toBe("Unauthorized");
  });

  it("should allow access with correct secret", async () => {
    process.env.CACHE_WARM_SECRET = "test-secret";
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [],
      offset: 0,
    } as any);
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    const request = {
      nextUrl: {
        searchParams: {
          get: jest.fn().mockReturnValue("test-secret"),
        },
      },
    } as any;
    const response = await GET(request);

    expect(response.status).toBe(200);
  });

  it("should reject incorrect secret", async () => {
    process.env.CACHE_WARM_SECRET = "test-secret";

    const request = {
      nextUrl: {
        searchParams: {
          get: jest.fn().mockReturnValue("wrong-secret"),
        },
      },
    } as any;
    const response = await GET(request);

    expect(response.status).toBe(401);
  });

  it("should return duration and timestamp", async () => {
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [],
      offset: 0,
    } as any);
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    const request = {
      nextUrl: {
        searchParams: {
          get: jest.fn().mockReturnValue(null),
        },
      },
    } as any;
    const response = await GET(request);
    const data = await response.json();

    expect(data.duration).toMatch(/\d+ms/);
    expect(data.timestamp).toBeDefined();
    expect(new Date(data.timestamp).getTime()).toBeGreaterThan(0);
  });

  it("should call getTopShortsData with correct parameters", async () => {
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [],
      offset: 0,
    } as any);
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    const request = {
      nextUrl: {
        searchParams: {
          get: jest.fn().mockReturnValue(null),
        },
      },
    } as any;
    await GET(request);

    expect(mockGetTopShortsData).toHaveBeenCalledWith("3m", 50, 0);
    expect(mockGetTopShortsData).toHaveBeenCalledWith("1m", 50, 0);
    expect(mockGetTopShortsData).toHaveBeenCalledWith("6m", 50, 0);
    expect(mockGetTopShortsData).toHaveBeenCalledWith("1y", 50, 0);
  });

  it("should call getIndustryTreeMap with correct parameters", async () => {
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [],
      offset: 0,
    } as any);
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    const request = {
      nextUrl: {
        searchParams: {
          get: jest.fn().mockReturnValue(null),
        },
      },
    } as any;
    await GET(request);

    expect(mockGetIndustryTreeMap).toHaveBeenCalledWith(
      "3m",
      10,
      ViewMode.CURRENT_CHANGE,
    );
  });
});

