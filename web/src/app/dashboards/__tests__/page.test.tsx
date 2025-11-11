import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import Dashboards from "../page";

// Mock next-auth
const mockUseSession = jest.fn();
jest.mock("next-auth/react", () => ({
  useSession: () => mockUseSession(),
}));

// Mock dependencies
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: any) => <div data-testid="dashboard-layout">{children}</div>,
}));

jest.mock("~/@/components/dashboard/dashboard-grid", () => ({
  DashboardGrid: () => <div data-testid="dashboard-grid">Dashboard Grid</div>,
}));

jest.mock("~/@/components/dashboard/widget-config-dialog", () => ({
  WidgetConfigDialog: () => <div>Widget Config Dialog</div>,
}));

jest.mock("~/@/lib/widget-registry", () => ({
  widgetRegistry: {
    getDefinition: jest.fn(),
    getByCategory: jest.fn(() => []),
  },
}));

jest.mock("~/@/lib/dashboard-service", () => ({
  dashboardService: {
    getUserDashboards: jest.fn().mockResolvedValue([]),
    saveDashboard: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock("~/@/hooks/use-toast", () => ({
  useToast: () => ({
    toast: jest.fn(),
  }),
}));

jest.mock("~/@/components/auth/login-required", () => ({
  LoginRequired: ({ title, description }: any) => (
    <div data-testid="login-required">
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  ),
}));

describe("Dashboards Page Authentication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("shows login required when user is not authenticated", () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
      update: jest.fn(),
    });

    render(<Dashboards />);

    expect(screen.getByTestId("login-required")).toBeInTheDocument();
    expect(screen.getByText("Sign in Required")).toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-grid")).not.toBeInTheDocument();
  });

  it("shows loading state while checking authentication", () => {
    mockUseSession.mockReturnValue({
      data: null,
      status: "loading",
      update: jest.fn(),
    });

    render(<Dashboards />);

    expect(screen.getByTestId("dashboard-layout")).toBeInTheDocument();
    // Should show loading spinner, not login required
    expect(screen.queryByTestId("login-required")).not.toBeInTheDocument();
  });

  it("REPRODUCES BUG: shows dashboard when user is authenticated with session from server", async () => {
    // This simulates the session being passed from server to client via SessionProvider
    const mockSession = {
      user: {
        id: "test-user-id",
        name: "Test User",
        email: "test@example.com",
      },
      expires: "2099-01-01",
    };

    mockUseSession.mockReturnValue({
      data: mockSession,
      status: "authenticated",
      update: jest.fn(),
    });

    render(<Dashboards />);

    // Should show dashboard, not login required
    await waitFor(() => {
      expect(screen.getByTestId("dashboard-grid")).toBeInTheDocument();
    });
    
    expect(screen.queryByTestId("login-required")).not.toBeInTheDocument();
    expect(screen.getByText("Dashboard")).toBeInTheDocument();
  });

  it("REPRODUCES BUG: transitions from loading to authenticated without showing login screen", async () => {
    // Start with loading state (initial hydration)
    mockUseSession.mockReturnValue({
      data: null,
      status: "loading",
      update: jest.fn(),
    });

    const { rerender } = render(<Dashboards />);

    // Should show loading spinner
    expect(screen.getByTestId("dashboard-layout")).toBeInTheDocument();
    expect(screen.queryByTestId("login-required")).not.toBeInTheDocument();
    expect(screen.queryByTestId("dashboard-grid")).not.toBeInTheDocument();

    // Session becomes available (server session hydrated)
    const mockSession = {
      user: {
        id: "test-user-id",
        name: "Test User",
        email: "test@example.com",
      },
      expires: "2099-01-01",
    };

    mockUseSession.mockReturnValue({
      data: mockSession,
      status: "authenticated",
      update: jest.fn(),
    });

    rerender(<Dashboards />);

    // Should transition directly to dashboard, no flash of login required
    await waitFor(() => {
      expect(screen.getByTestId("dashboard-grid")).toBeInTheDocument();
    });
    
    expect(screen.queryByTestId("login-required")).not.toBeInTheDocument();
  });

  it("does not flash login screen when session is available immediately", () => {
    // This is the IDEAL case with our fix - session is available from first render
    const mockSession = {
      user: {
        id: "test-user-id",
        name: "Test User",
        email: "test@example.com",
      },
      expires: "2099-01-01",
    };

    mockUseSession.mockReturnValue({
      data: mockSession,
      status: "authenticated",
      update: jest.fn(),
    });

    render(<Dashboards />);

    // Should show dashboard immediately
    expect(screen.getByTestId("dashboard-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("login-required")).not.toBeInTheDocument();
    
    // Login screen should never have been rendered
    const loginRequired = screen.queryByTestId("login-required");
    expect(loginRequired).not.toBeInTheDocument();
  });
});

