import { getTopShortsData } from "../actions/getTopShorts";
import { getIndustryTreeMap } from "../actions/getIndustryTreeMap";
import { render } from "@testing-library/react";

// Mock ViewMode enum
const ViewMode = {
  CURRENT_CHANGE: 1,
} as const;

// Mock the server actions
jest.mock("../actions/getTopShorts", () => ({
  getTopShortsData: jest.fn(),
}));

jest.mock("../actions/getIndustryTreeMap", () => ({
  getIndustryTreeMap: jest.fn(),
}));

jest.mock("../page-client", () => ({
  HomePageClient: ({ initialTopShortsData, initialTreeMapData }: any) => (
    <div data-testid="homepage-client">
      <div data-testid="top-shorts-data">
        {initialTopShortsData?.length ?? 0} items
      </div>
      <div data-testid="treemap-data">
        {initialTreeMapData ? "present" : "missing"}
      </div>
    </div>
  ),
}));

// Mock protobuf to avoid import issues
jest.mock("~/gen/shorts/v1alpha1/shorts_pb", () => ({
  ViewMode: {
    CURRENT_CHANGE: 1,
  },
}));

// Import HomePage after mocks
let HomePage: any;

const mockGetTopShortsData = getTopShortsData as jest.MockedFunction<
  typeof getTopShortsData
>;
const mockGetIndustryTreeMap = getIndustryTreeMap as jest.MockedFunction<
  typeof getIndustryTreeMap
>;

describe("HomePage Server Component", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    
    // Dynamically import HomePage after mocks
    const page = await import("../page");
    HomePage = page.default;
  });

  it("should fetch data server-side and pass to client component", async () => {
    const mockTopShortsData = {
      timeSeries: [
        { productCode: "CBA", name: "Commonwealth Bank" },
        { productCode: "ZIP", name: "ZIP Co" },
      ],
      offset: 0,
    };

    const mockTreeMapData = {
      industries: [],
      stocks: [],
    };

    mockGetTopShortsData.mockResolvedValue(mockTopShortsData as any);
    mockGetIndustryTreeMap.mockResolvedValue(mockTreeMapData as any);

    const component = await HomePage();
    const { getByTestId } = render(component);

    expect(getByTestId("homepage-client")).toBeInTheDocument();
    expect(getByTestId("top-shorts-data")).toHaveTextContent("2 items");
    expect(getByTestId("treemap-data")).toHaveTextContent("present");
  });

  it("should handle API failures gracefully", async () => {
    mockGetTopShortsData.mockRejectedValue(new Error("API error"));
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    const component = await HomePage();
    const { getByTestId } = render(component);

    expect(getByTestId("homepage-client")).toBeInTheDocument();
    expect(getByTestId("top-shorts-data")).toHaveTextContent("0 items");
    expect(getByTestId("treemap-data")).toHaveTextContent("present");
  });

  it("should fetch data in parallel", async () => {
    let topShortsResolved = false;
    let treemapResolved = false;

    mockGetTopShortsData.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      topShortsResolved = true;
      return { timeSeries: [], offset: 0 } as any;
    });

    mockGetIndustryTreeMap.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      treemapResolved = true;
      return { industries: [], stocks: [] } as any;
    });

    const startTime = Date.now();
    await HomePage();
    const duration = Date.now() - startTime;

    // Should complete in ~10ms (parallel) not ~20ms (sequential)
    expect(duration).toBeLessThan(20);
    expect(topShortsResolved).toBe(true);
    expect(treemapResolved).toBe(true);
  });

  it("should call actions with correct default parameters", async () => {
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [],
      offset: 0,
    } as any);
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    await HomePage();

    expect(mockGetTopShortsData).toHaveBeenCalledWith("3m", 50, 0);
    expect(mockGetIndustryTreeMap).toHaveBeenCalledWith(
      "3m",
      10,
      ViewMode.CURRENT_CHANGE,
    );
  });
});

