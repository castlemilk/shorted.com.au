import "@testing-library/jest-dom";
import React from "react";
import { render, screen, waitFor } from "@testing-library/react";
import type { Mock } from "jest-mock";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import Page from "../page";

// Mock auth server function
jest.mock("~/server/auth", () => ({
  auth: jest.fn().mockResolvedValue({
    user: { id: "test-user", email: "test@example.com" },
  }),
}));

// Mock the shorts API
jest.mock("~/app/actions/getTopShorts", () => ({
  getTopShortsData: jest.fn(),
}));

// Mock next/navigation
jest.mock("next/navigation", () => ({
  useRouter: jest.fn(() => ({
    push: jest.fn(),
  })),
  redirect: jest.fn((url: string) => {
    throw new Error(`Redirected to: ${url}`);
  }),
}));

// Mock TopShortsClient component
jest.mock("../components/top-shorts-client", () => ({
  TopShortsClient: ({ initialMoversData, initialPeriod }: any) => (
    <div data-testid="top-shorts-client">
      <div data-testid="initial-period">{initialPeriod}</div>
    </div>
  ),
}));

// Mock Skeleton component
jest.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: any) => (
    <div data-testid="skeleton" className={className}></div>
  ),
}));

// Mock DashboardLayout
jest.mock("@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: any) => (
    <div data-testid="dashboard-layout">{children}</div>
  ),
}));

// Mock calculateMovers
jest.mock("@/lib/shorts-calculations", () => ({
  calculateMovers: jest.fn((timeSeries: any) => ({
    biggestIncreases: [],
    biggestDecreases: [],
    mostVolatile: [],
  })),
}));

describe("/shorts Page (Client-Side)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Client-Side Data Fetching", () => {
    it("should fetch initial data with default period (3m)", async () => {
      const mockData = {
        timeSeries: [
          {
            stockCode: "CBA",
            companyName: "Commonwealth Bank",
            latestShortPosition: 5.2,
            points: [
              {
                shortPosition: 5.0,
                timestamp: { seconds: BigInt(1000000), nanos: 0 },
              },
              {
                shortPosition: 5.2,
                timestamp: { seconds: BigInt(1000100), nanos: 0 },
              },
            ],
          },
          {
            stockCode: "BHP",
            companyName: "BHP Group",
            latestShortPosition: 3.8,
            points: [
              {
                shortPosition: 4.0,
                timestamp: { seconds: BigInt(1000000), nanos: 0 },
              },
              {
                shortPosition: 3.8,
                timestamp: { seconds: BigInt(1000100), nanos: 0 },
              },
            ],
          },
        ],
        totalCount: 2,
      };

      (getTopShortsData as Mock).mockResolvedValue(mockData);

      // Render async server component
      const { default: Component } = await import("../page");
      const result = await Component();
      render(result);

      await waitFor(() => {
        expect(getTopShortsData).toHaveBeenCalledWith("3m", 20, 0);
        expect(screen.getByTestId("top-shorts-client")).toBeInTheDocument();
        expect(screen.getByTestId("initial-period")).toHaveTextContent("3m");
      });
    });

    it("should handle empty data gracefully", async () => {
      (getTopShortsData as Mock).mockResolvedValue({
        timeSeries: [],
        totalCount: 0,
      });

      // Render async server component
      const { default: Component } = await import("../page");
      const result = await Component();
      render(result);

      await waitFor(() => {
        expect(screen.getByTestId("top-shorts-client")).toBeInTheDocument();
      });
    });
  });
});
