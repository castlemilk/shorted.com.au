import "@testing-library/jest-dom";
import React from "react";
import { render, screen } from "@testing-library/react";
import type { Mock } from "jest-mock";
import { getTopShortsData } from "~/app/actions/getTopShorts";
import Page, { metadata } from "../page";
import type { Metadata } from "next";

// Mock the shorts API
jest.mock("~/app/actions/getTopShorts", () => ({
  getTopShortsData: jest.fn(),
}));

// Mock auth
jest.mock("@/auth", () => ({
  auth: jest.fn().mockResolvedValue({ user: { id: "test-user" } }),
}));

// Mock TopShortsClient component
jest.mock("../components/top-shorts-client", () => ({
  TopShortsClient: ({ initialMoversData, initialPeriod }: any) => (
    <div data-testid="top-shorts-client">
      <div data-testid="initial-period">{initialPeriod}</div>
    </div>
  ),
}));

describe("/shorts Page (SSR)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Server-Side Data Fetching", () => {
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

      const jsx = await Page();
      render(jsx);

      expect(getTopShortsData).toHaveBeenCalledWith("3m", 20, 0);
      expect(screen.getByTestId("top-shorts-client")).toBeInTheDocument();
      expect(screen.getByTestId("initial-period")).toHaveTextContent("3m");
    });

    it("should handle empty data gracefully", async () => {
      (getTopShortsData as Mock).mockResolvedValue({
        timeSeries: [],
        totalCount: 0,
      });

      const jsx = await Page();
      render(jsx);

      expect(screen.getByTestId("top-shorts-client")).toBeInTheDocument();
    });
  });

  describe("Metadata Configuration", () => {
    it("should have correct metadata for SEO", () => {
      const meta = metadata as Metadata;
      expect(meta.title).toContain("Shorted");
      expect(meta.description).toBeTruthy();
      expect(meta.keywords).toContain("short interest");
      expect(meta.keywords).toContain("ASX shorts");
      expect(meta.openGraph?.title).toBeTruthy();
      if (meta.openGraph && typeof meta.openGraph !== "string") {
        expect(meta.openGraph.type).toBe("website");
      }
    });
  });

  describe("ISR Configuration", () => {
    it("should have revalidate time configured", async () => {
      // The revalidate export should be present
      const pageModule = await import("../page");
      expect(pageModule.revalidate).toBe(300); // 5 minutes
    });
  });
});
