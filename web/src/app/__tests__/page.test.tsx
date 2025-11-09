import React from "react";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import Home from "../page";

// Mock next-auth session hook
jest.mock("next-auth/react", () => ({
  useSession: jest.fn(),
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
      Top Shorts: {initialPeriod}
    </div>
  ),
}));

jest.mock("../treemap/treeMap", () => ({
  IndustryTreeMapView: ({ initialPeriod, initialViewMode }: any) => (
    <div data-testid="tree-map">
      Tree Map: {initialPeriod} - {initialViewMode}
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
jest.mock("@/components/ui/login-prompt-banner", () => ({
  LoginPromptBanner: () => <div data-testid="login-prompt-banner"></div>,
}));

// Import the mocked functions
const { useSession } = require("next-auth/react");

const mockUseSession = useSession as jest.MockedFunction<typeof useSession>;

describe("Home Page", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Set up default mocks - no session by default
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    } as any);
  });

  it("renders the home page with all components", () => {
    render(<Home />);

    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
    expect(screen.getByTestId("top-shorts")).toBeInTheDocument();
    expect(screen.getByTestId("tree-map")).toBeInTheDocument();
  });

  it("renders with flex layout", () => {
    const { container } = render(<Home />);

    const layoutDiv = container.querySelector(".flex");
    expect(layoutDiv).toBeInTheDocument();
  });

  it("renders with correct layout structure", () => {
    const { container } = render(<Home />);

    // Check for flex layout
    const flexElement = container.querySelector(".flex");
    expect(flexElement).toBeInTheDocument();

    // Check for Google Analytics
    expect(screen.getByTestId("google-analytics")).toBeInTheDocument();
  });

  it("includes Google Analytics with correct ID", () => {
    render(<Home />);

    const gaElement = screen.getByTestId("google-analytics");
    expect(gaElement).toHaveAttribute("data-ga-id", "G-X85RLQ4N2N");
  });

  it("shows login prompt banner when user is not authenticated", () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    } as any);

    render(<Home />);

    expect(screen.getByTestId("login-prompt-banner")).toBeInTheDocument();
  });

  it("hides login prompt banner when user is authenticated", () => {
    mockUseSession.mockReturnValue({
      data: {
        user: { id: "123", email: "test@example.com" },
        expires: "2025-12-31",
      },
      status: "authenticated",
      update: jest.fn(),
    } as any);

    render(<Home />);

    expect(
      screen.queryByTestId("login-prompt-banner"),
    ).not.toBeInTheDocument();
  });

  it("passes correct period to TopShorts component", () => {
    render(<Home />);

    expect(screen.getByText("Top Shorts: 3m")).toBeInTheDocument();
  });

  it("passes correct props to IndustryTreeMapView component", () => {
    render(<Home />);

    expect(
      screen.getByText("Tree Map: 3m - CURRENT_CHANGE"),
    ).toBeInTheDocument();
  });
});
