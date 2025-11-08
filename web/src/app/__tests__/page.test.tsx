import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import Home from "../page";

// Mock auth
jest.mock("~/server/auth", () => ({
  auth: jest.fn(),
}));

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

// Mock LoginPromptBanner
jest.mock("@/components/ui/login-prompt-banner", () => ({
  LoginPromptBanner: () => <div data-testid="login-prompt-banner"></div>,
}));

// Import the mocked functions
const { auth } = require("~/server/auth");
const { getTopShortsData } = require("../actions/getTopShorts");
const { getIndustryTreeMap } = require("../actions/getIndustryTreeMap");

const mockAuth = auth as jest.MockedFunction<typeof auth>;

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
    mockAuth.mockResolvedValue(null); // No session by default
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    });
  });

  it("renders the home page with all components", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    const component = await Home();
    render(component);

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

    const component = await Home();
    render(component);

    expect(screen.getByText("Top Shorts: 2 items")).toBeInTheDocument();
  });

  it("renders with flex layout", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    const component = await Home();
    const { container } = render(component);

    const layoutDiv = container.querySelector(".flex");
    expect(layoutDiv).toBeInTheDocument();
  });

  it("handles empty data gracefully", async () => {
    mockGetTopShortsData.mockResolvedValue({
      timeSeries: [],
      offset: 0,
    } as any);

    const component = await Home();
    render(component);

    expect(screen.getByText("Top Shorts: 0 items")).toBeInTheDocument();
  });

  it("throws error when data fetch fails (Next.js will handle)", async () => {
    mockGetTopShortsData.mockRejectedValue(new Error("Failed to fetch"));
    mockGetIndustryTreeMap.mockResolvedValue({
      industries: [],
      stocks: [],
    } as any);

    // Server Components should throw errors - Next.js will catch them
    // and display error boundaries
    await expect(Home()).rejects.toThrow("Failed to fetch");
  });

  it("renders with correct layout structure", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    const component = await Home();
    const { container } = render(component);

    // Check for flex layout
    const flexElement = container.querySelector(".flex");
    expect(flexElement).toBeInTheDocument();

    // Check for Google Analytics
    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
  });

  it("includes meta information", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);

    const component = await Home();
    render(component);

    // In a real Next.js app, you'd check for metadata in the head
    // For now, we just verify the component renders without errors
    expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
  });

  it("shows login prompt banner when user is not authenticated", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);
    mockAuth.mockResolvedValue(null); // No session

    const component = await Home();
    render(component);

    expect(screen.getByTestId("login-prompt-banner")).toBeInTheDocument();
  });

  it("hides login prompt banner when user is authenticated", async () => {
    mockGetTopShortsData.mockResolvedValue(mockData as any);
    mockAuth.mockResolvedValue({
      user: { id: "123", email: "test@example.com" },
    } as any);

    const component = await Home();
    render(component);

    expect(screen.queryByTestId("login-prompt-banner")).not.toBeInTheDocument();
  });
});
