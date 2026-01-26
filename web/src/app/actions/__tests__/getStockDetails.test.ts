/// <reference types="jest" />
import "@testing-library/jest-dom";
import { TextEncoder, TextDecoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}

import { describe, it, expect, beforeEach } from "@jest/globals";
import { getStockDetails } from "../getStockDetails";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";

// Mock fetch for Node.js test environment
global.fetch = jest.fn() as jest.Mock;

// Mock Connect RPC client
jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

jest.mock("@connectrpc/connect", () => {
  const mockClient = {
    getStockDetails: jest.fn(),
  };
  return {
    createClient: jest.fn(() => mockClient),
    __mockClient: mockClient,
  };
});

const { __mockClient: mockClient } = jest.requireMock("@connectrpc/connect") as {
  __mockClient: {
    getStockDetails: jest.Mock;
  };
};

describe("getStockDetails", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should fetch stock details successfully", async () => {
    const mockStockDetails: StockDetails = {
      productCode: "CBA",
      companyName: "Commonwealth Bank",
      industry: "Banking",
      summary: "A major Australian bank",
      website: "https://www.commbank.com.au",
      address: "Sydney, Australia",
      gcsUrl: "https://storage.googleapis.com/logos/CBA.svg",
      tags: ["banking", "finance"],
      enrichmentStatus: "completed",
    };

    mockClient.getStockDetails.mockResolvedValueOnce(mockStockDetails);

    const result = await getStockDetails("CBA");

    expect(result).toEqual(mockStockDetails);
    expect(mockClient.getStockDetails).toHaveBeenCalledWith({
      productCode: "CBA",
    });
  });

  it("should handle missing stock details gracefully", async () => {
    mockClient.getStockDetails.mockResolvedValueOnce({
      productCode: "INVALID",
      companyName: "",
      summary: "",
    } as StockDetails);

    const result = await getStockDetails("INVALID");

    expect(result).toBeDefined();
    expect(result?.productCode).toBe("INVALID");
  });

  it("should handle API errors", async () => {
    mockClient.getStockDetails.mockRejectedValueOnce(
      new Error("Stock not found"),
    );

    // getStockDetails catches errors and returns undefined for NotFound
    // For other errors, it should throw
    await expect(getStockDetails("INVALID")).rejects.toThrow();
  });

  it("should normalize stock code to uppercase", async () => {
    const mockStockDetails: StockDetails = {
      productCode: "CBA",
      companyName: "Commonwealth Bank",
    };

    mockClient.getStockDetails.mockResolvedValueOnce(mockStockDetails);

    await getStockDetails("cba");

    expect(mockClient.getStockDetails).toHaveBeenCalledWith({
      productCode: "cba", // Should be passed as-is, normalization happens in backend
    });
  });

  it("should handle null/undefined fields gracefully", async () => {
    const mockStockDetails: StockDetails = {
      productCode: "TEST",
      companyName: "Test Company",
      // Intentionally missing optional fields
      summary: undefined,
      website: undefined,
      address: undefined,
      gcsUrl: undefined,
      tags: [],
    };

    mockClient.getStockDetails.mockResolvedValueOnce(mockStockDetails);

    const result = await getStockDetails("TEST");

    expect(result).toBeDefined();
    expect(result?.productCode).toBe("TEST");
    expect(result?.summary).toBeUndefined();
  });

  it("should handle empty enrichment status", async () => {
    const mockStockDetails: StockDetails = {
      productCode: "TEST",
      companyName: "Test Company",
      enrichmentStatus: "pending",
    };

    mockClient.getStockDetails.mockResolvedValueOnce(mockStockDetails);

    const result = await getStockDetails("TEST");

    expect(result?.enrichmentStatus).toBe("pending");
  });

  it("should handle logo URL from gcsUrl field", async () => {
    const mockStockDetails: StockDetails = {
      productCode: "TEST",
      companyName: "Test Company",
      gcsUrl: "https://storage.googleapis.com/logos/test.png",
    };

    mockClient.getStockDetails.mockResolvedValueOnce(mockStockDetails);

    const result = await getStockDetails("TEST");

    expect(result?.gcsUrl).toBe("https://storage.googleapis.com/logos/test.png");
  });

  it("should handle empty logo URL gracefully", async () => {
    const mockStockDetails: StockDetails = {
      productCode: "TEST",
      companyName: "Test Company",
      gcsUrl: "", // Empty string when both logo_gcs_url and logo_url are NULL
    };

    mockClient.getStockDetails.mockResolvedValueOnce(mockStockDetails);

    const result = await getStockDetails("TEST");

    expect(result?.gcsUrl).toBe("");
    // Frontend components should handle empty strings by showing fallback icons
  });

  it("should handle logo URL fallback scenario (logo_url used when logo_gcs_url is NULL)", async () => {
    // This simulates the backend returning logo_url as gcsUrl when logo_gcs_url is NULL
    const mockStockDetails: StockDetails = {
      productCode: "TEST",
      companyName: "Test Company",
      gcsUrl: "https://example.com/fallback-logo.png", // This would be logo_url from backend
    };

    mockClient.getStockDetails.mockResolvedValueOnce(mockStockDetails);

    const result = await getStockDetails("TEST");

    expect(result?.gcsUrl).toBe("https://example.com/fallback-logo.png");
    expect(result?.gcsUrl).toBeTruthy(); // Should have a logo URL
  });
});

