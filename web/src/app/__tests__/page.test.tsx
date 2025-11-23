import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
// Import the client component for testing (server component is tested separately)
import { HomePageClient } from "../page-client";

// Mock next-auth for client-side
jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
}));

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

// Mock @next/third-parties/google for Google Analytics
jest.mock("@next/third-parties/google", () => ({
  GoogleAnalytics: ({ gaId }: { gaId?: string }) => (
    <div data-testid="google-analytics" data-ga-id={gaId}></div>
  ),
}));

// Mock UI components
jest.mock("~/@/components/ui/button", () => ({
  Button: ({ children, onClick }: any) => (
    <button onClick={onClick}>{children}</button>
  ),
}));

// Mock Marketing components
jest.mock("~/@/components/marketing/scroll-reveal", () => ({
  ScrollReveal: ({ children }: any) => <div>{children}</div>,
}));

jest.mock("~/@/components/marketing/animated-stock-ticker", () => ({
  AnimatedStockTicker: () => (
    <div data-testid="animated-stock-ticker">Ticker</div>
  ),
}));

jest.mock("~/@/components/marketing/background-beams", () => ({
  BackgroundBeams: () => <div data-testid="background-beams">Beams</div>,
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

// Mock dynamic import for treemap
jest.mock("next/dynamic", () => {
  const actualDynamic = jest.requireActual("next/dynamic");
  return (importFn: any, options: any) => {
    // For treemap component, return the mocked component directly
    if (importFn.toString().includes("treemap/treeMap")) {
      return ({ initialPeriod, initialViewMode }: any) => (
        <div data-testid="tree-map">
          Tree Map Component (period: {initialPeriod})
        </div>
      );
    }
    // For other dynamic imports, use the actual dynamic
    return actualDynamic(importFn, options);
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

  it("renders the home page with all components", async () => {
    render(<HomePageClient />);

    // Wait for dynamically imported TopShorts to resolve
    await waitFor(() => {
      expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
    });

    // Wait for dynamic import to resolve
    await waitFor(() => {
      expect(screen.getByTestId("tree-map")).toBeInTheDocument();
    });

    // Google Analytics should be rendered immediately
    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
  });

  it("passes correct initial period to components", async () => {
    render(<HomePageClient />);

    expect(
      screen.getByText(/Top Shorts Component \(period: 3m\)/),
    ).toBeInTheDocument();

    // Wait for dynamic import to resolve
    await waitFor(() => {
      expect(
        screen.getByText(/Tree Map Component \(period: 3m\)/),
      ).toBeInTheDocument();
    });
  });

  it("renders with flex layout", () => {
    const { container } = render(<HomePageClient />);

    const layoutDiv = container.querySelector(".flex");
    expect(layoutDiv).toBeInTheDocument();
  });

  it("shows login banner when not authenticated", () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    });

    render(<HomePageClient />);

    expect(screen.getByTestId("login-prompt-banner")).toBeInTheDocument();
  });

  it("renders with correct layout structure", async () => {
    const { container } = render(<HomePageClient />);

    // Check for flex layout
    const flexElement = container.querySelector(".flex");
    expect(flexElement).toBeInTheDocument();

    // Google Analytics is deferred, so wait for it to load
    await waitFor(
      () => {
        expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
      },
      { timeout: 3000 },
    );
  });

  it("includes all expected components", async () => {
    render(<HomePageClient />);

    // Verify all main components are present
    expect(screen.getByTestId("top-shorts")).toBeInTheDocument();

    // Wait for dynamic import to resolve
    await waitFor(() => {
      expect(screen.getByTestId("tree-map")).toBeInTheDocument();
    });

    // Google Analytics should be rendered immediately
    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
  });

  it("shows login prompt banner when user is not authenticated", () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    });

    render(<HomePageClient />);

    expect(screen.getByTestId("login-prompt-banner")).toBeInTheDocument();
  });

  it("hides login prompt banner when user is authenticated", () => {
    mockUseSession.mockReturnValue({
      data: { user: { id: "123", email: "test@example.com" } },
      status: "authenticated",
      update: jest.fn(),
    } as any);

    render(<HomePageClient />);

    expect(screen.queryByTestId("login-prompt-banner")).not.toBeInTheDocument();
  });

  it("has session immediately available without flash of unauthenticated content", async () => {
    // This test verifies the auth fix where session is passed from server to client
    // preventing a flash of unauthenticated content (login banner)
    const sessionData = {
      user: {
        id: "test-user-id",
        name: "Test User",
        email: "test@example.com",
      },
      expires: "2099-01-01",
    };

    mockUseSession.mockReturnValue({
      data: sessionData,
      status: "authenticated",
      update: jest.fn(),
    });

    render(<HomePageClient />);

    // Login banner should NOT be present from the first render
    expect(screen.queryByTestId("login-prompt-banner")).not.toBeInTheDocument();

    // Components should render immediately without waiting for session
    expect(screen.getByTestId("top-shorts")).toBeInTheDocument();

    // Wait for dynamic import to resolve
    await waitFor(() => {
      expect(screen.getByTestId("tree-map")).toBeInTheDocument();
    });
  });

  it("renders responsive layout classes", () => {
    const { container } = render(<HomePageClient />);

    // Check for responsive layout classes
    // The simplified page uses: <div className="flex flex-col lg:flex-row gap-8">
    const layoutDiv = container.querySelector(".flex.flex-col.lg\\:flex-row");
    expect(layoutDiv).toBeInTheDocument();
  });
});
