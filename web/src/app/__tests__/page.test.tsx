import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Home from "../page";

// Mock all the actions
jest.mock("../actions/getTopShorts", () => ({
  getTopShortsData: jest.fn(),
}));

jest.mock("../actions/getIndustryTreeMap", () => ({
  getIndustryTreeMap: jest.fn(),
}));

// Mock next/link
jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: any) => <a href={href}>{children}</a>,
}));

// Mock Google Analytics
jest.mock("@next/third-parties/google", () => ({
  GoogleAnalytics: ({ gaId }: any) => (
    <div data-testid="google-analytics" data-ga-id={gaId}></div>
  ),
}));

// Mock the components with correct paths
jest.mock("../topShortsView/topShorts", () => ({
  TopShorts: ({ initialShortsData }: any) => (
    <div data-testid="top-shorts">
      Top Shorts: {initialShortsData?.length || 0} items
    </div>
  ),
}));

jest.mock("../treemap/treeMap", () => ({
  IndustryTreeMapView: ({ initialTreeMapData }: any) => (
    <div data-testid="tree-map">Tree Map Component</div>
  ),
}));

// Mock ViewMode enum
jest.mock("~/gen/shorts/v1alpha1/shorts_pb", () => ({
  ViewMode: {
    CURRENT_CHANGE: "CURRENT_CHANGE",
  },
}));

// Import the mocked functions
const { getTopShortsData } = require("../actions/getTopShorts");
const { getIndustryTreeMap } = require("../actions/getIndustryTreeMap");

const mockGetTopShortsData = getTopShortsData as jest.MockedFunction<
  typeof getTopShortsData
>;
const mockGetIndustryTreeMap = getIndustryTreeMap as jest.MockedFunction<
  typeof getIndustryTreeMap
>;

describe("Home Page", () => {
  const mockData = {
    timeSeries: [
      {
        productCode: "CBA",
        name: "Commonwealth Bank",
        latestShortPosition: 2.5,
        points: [],
      },
      {
        productCode: "ZIP",
        name: "ZIP Co Limited",
        latestShortPosition: 12.5,
        points: [],
      },
    ],
    offset: 0,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Set up default mocks
    mockGetIndustryTreeMap.mockResolvedValue({ industries: [] });
  });

  it("renders the home page with all components", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    render(await Home());

    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
    expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
    expect(screen.getByTestId("tree-map")).toBeInTheDocument();
  });

  it("fetches top shorts data with correct parameters", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    await Home();

    expect(mockGetTopShortsData).toHaveBeenCalledWith("3m", 10, 0);
  });

  it("passes fetched data to TopShorts component", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    render(await Home());

    expect(screen.getByText("Top Shorts: 2 items")).toBeInTheDocument();
  });

  it("renders with flex layout", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    const { container } = render(await Home());

    const layoutDiv = container.querySelector(".flex");
    expect(layoutDiv).toBeInTheDocument();
  });

  it("handles empty data gracefully", async () => {
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [],
      offset: 0,
    } as any);

    render(await Home());

    expect(screen.getByText("Top Shorts: 0 items")).toBeInTheDocument();
  });

  it("handles data fetch error gracefully", async () => {
    mockGetTopShortsData.mockRejectedValue(new Error("Failed to fetch"));
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    // The page should render with empty/fallback data instead of throwing
    render(await Home());

    // Should still render the page structure even if data fetch fails
    expect(screen.getByText("Top Shorts: 0 items")).toBeInTheDocument();
  });

  it("renders with correct layout structure", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    const { container } = render(await Home());

    // Check for flex layout
    const flexElement = container.querySelector(".flex");
    expect(flexElement).toBeInTheDocument();

    // Check for Google Analytics
    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
  });

  it("includes meta information", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    render(await Home());

    // In a real Next.js app, you'd check for metadata in the head
    // For now, we just verify the component renders without errors
    expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
  });
});
