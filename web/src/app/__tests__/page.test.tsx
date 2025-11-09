import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import Home from "../page";

// Mock next-auth for client-side
jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
}));

// Mock the client-side actions
jest.mock("../actions/client/getTopShorts", () => ({
  getTopShortsDataClient: jest.fn(),
}));

jest.mock("../actions/client/getIndustryTreeMap", () => ({
  getIndustryTreeMapClient: jest.fn(),
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
  TopShorts: ({ initialPeriod }: any) => (
    <div data-testid="top-shorts">
      Top Shorts Component (period: {initialPeriod})
    </div>
  ),
}));

jest.mock("../treemap/treeMap", () => ({
  IndustryTreeMapView: ({ initialPeriod }: any) => (
    <div data-testid="tree-map">
      Tree Map Component (period: {initialPeriod})
    </div>
  ),
}));

// Mock ViewMode enum
jest.mock("~/gen/shorts/v1alpha1/shorts_pb", () => ({
  ViewMode: {
    CURRENT_CHANGE: "CURRENT_CHANGE",
  },
}));

// Mock LoginPromptBanner
jest.mock("~/@/components/ui/login-prompt-banner", () => ({
  LoginPromptBanner: () => <div data-testid="login-prompt-banner"></div>,
}));

// Import the mocked functions
const { useSession } = require("next-auth/react");
const { getTopShortsDataClient } = require("../actions/client/getTopShorts");
const {
  getIndustryTreeMapClient,
} = require("../actions/client/getIndustryTreeMap");

const mockUseSession = useSession as jest.MockedFunction<typeof useSession>;

const mockGetTopShortsDataClient =
  getTopShortsDataClient as jest.MockedFunction<typeof getTopShortsDataClient>;
const mockGetIndustryTreeMapClient =
  getIndustryTreeMapClient as jest.MockedFunction<
    typeof getIndustryTreeMapClient
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
    // Set up default mocks for client-side rendering
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    });
    mockGetIndustryTreeMapClient.mockResolvedValue({
      industries: [],
      stocks: [],
    });
    mockGetTopShortsDataClient.mockResolvedValue(mockData as any);
  });

  it("renders the home page with all components", () => {
    render(<Home />);

    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
    expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
    expect(screen.getByTestId("tree-map")).toBeInTheDocument();
  });

  it("passes correct initial period to components", () => {
    render(<Home />);

    expect(
      screen.getByText(/Top Shorts Component \(period: 3m\)/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Tree Map Component \(period: 3m\)/),
    ).toBeInTheDocument();
  });

  it("renders with flex layout", () => {
    const { container } = render(<Home />);

    const layoutDiv = container.querySelector(".flex");
    expect(layoutDiv).toBeInTheDocument();
  });

  it("shows login banner when not authenticated", () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    });

    render(<Home />);

    expect(screen.getByTestId("login-prompt-banner")).toBeInTheDocument();
  });

  it("renders with correct layout structure", () => {
    const { container } = render(<Home />);

    // Check for flex layout
    const flexElement = container.querySelector(".flex");
    expect(flexElement).toBeInTheDocument();

    // Check for Google Analytics
    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
  });

  it("includes all expected components", () => {
    render(<Home />);

    // Verify all main components are present
    expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
    expect(screen.getByTestId("tree-map")).toBeInTheDocument();
    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
  });

  it("shows login prompt banner when user is not authenticated", () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    });

    render(<Home />);

    expect(screen.getByTestId("login-prompt-banner")).toBeInTheDocument();
  });

  it("hides login prompt banner when user is authenticated", () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: "123", email: "test@example.com" } },
      status: "authenticated",
      update: jest.fn(),
    } as any);

    render(<Home />);

    expect(screen.queryByTestId("login-prompt-banner")).not.toBeInTheDocument();
  });

  it("renders responsive layout classes", () => {
    const { container } = render(<Home />);

    // Check for responsive layout classes
    const layoutDiv = container.querySelector(".flex.flex-col.lg\\:flex-row");
    expect(layoutDiv).toBeInTheDocument();
  });
});
