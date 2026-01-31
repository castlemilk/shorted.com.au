import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { HomeContent } from "../home-content";

// Mock kv-cache to avoid Redis imports in tests
jest.mock("~/@/lib/kv-cache", () => require("~/@/lib/__mocks__/kv-cache"));

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

// Mock Lucide icons
jest.mock("lucide-react", () => ({
  ArrowRight: () => <div />,
  ChevronDown: () => <div />,
  Activity: () => <div />,
  Zap: () => <div />,
  Search: () => <div />,
  TrendingDown: () => <div />,
  TrendingUp: () => <div />,
}));

// Mock the components with correct paths
jest.mock("../topShortsView/topShorts", () => ({
  TopShorts: ({ initialPeriod }: any) => (
    <div data-testid="top-shorts">
      Top Shorts Component (period: {initialPeriod})
    </div>
  ),
}));

// Mock dynamic import for both TopShorts and treemap
jest.mock("next/dynamic", () => {
  return (importFn: any, options: any) => {
    const fnString = importFn.toString();
    if (fnString.includes("treemap/treeMap")) {
      return ({ initialPeriod }: any) => (
        <div data-testid="tree-map">
          Tree Map Component (period: {initialPeriod})
        </div>
      );
    }
    if (fnString.includes("topShortsView/topShorts")) {
      return ({ initialPeriod }: any) => (
        <div data-testid="top-shorts">
          Top Shorts Component (period: {initialPeriod})
        </div>
      );
    }
    // Fallback for other dynamic imports
    const React = require("react");
    return () => React.createElement("div", null, "Mocked Dynamic Component");
  };
});

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

// Import the mocked functions
const { getTopShortsDataClient } = require("../actions/client/getTopShorts");
const {
  getIndustryTreeMapClient,
} = require("../actions/client/getIndustryTreeMap");

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
    mockGetIndustryTreeMapClient.mockResolvedValue({
      industries: [],
      stocks: [],
    });
    mockGetTopShortsDataClient.mockResolvedValue(mockData as any);
  });

  it("renders the home page with all components", async () => {
    render(<HomeContent />);

    // Wait for dynamically imported TopShorts to resolve
    await waitFor(() => {
      expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
    });

    // Wait for dynamic import to resolve
    await waitFor(() => {
      expect(screen.getByTestId("tree-map")).toBeInTheDocument();
    });
  });

  it("passes correct initial period to components", async () => {
    render(<HomeContent />);

    await waitFor(() => {
      expect(
        screen.getByText(/Top Shorts Component \(period: 3m\)/),
      ).toBeInTheDocument();
    });

    // Wait for dynamic import to resolve
    await waitFor(() => {
      expect(
        screen.getByText(/Tree Map Component \(period: 3m\)/),
      ).toBeInTheDocument();
    });
  });

  it("renders with flex layout", async () => {
    const { container } = render(<HomeContent />);

    await waitFor(() => {
      const layoutDiv = container.querySelector(".flex");
      expect(layoutDiv).toBeInTheDocument();
    });
  });

  it("renders with correct layout structure", async () => {
    const { container } = render(<HomeContent />);

    // Check for flex layout
    await waitFor(() => {
      const flexElement = container.querySelector(".flex");
      expect(flexElement).toBeInTheDocument();
    });
  });

  it("includes all expected components", async () => {
    render(<HomeContent />);

    // Wait for dynamically imported components to resolve
    await waitFor(() => {
      expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.getByTestId("tree-map")).toBeInTheDocument();
    });
  });

  it("renders responsive layout classes", async () => {
    const { container } = render(<HomeContent />);

    // Check for responsive layout classes
    await waitFor(() => {
      const layoutDiv = container.querySelector(".flex.flex-col.lg\\:flex-row");
      expect(layoutDiv).toBeInTheDocument();
    });
  });
});
