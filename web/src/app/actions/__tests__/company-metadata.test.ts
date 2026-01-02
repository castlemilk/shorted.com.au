import { describe, it, expect, beforeEach } from "@jest/globals";
import { create } from "@bufbuild/protobuf";
import { TextEncoder, TextDecoder } from "util";

if (!globalThis.TextEncoder) {
  globalThis.TextEncoder = TextEncoder;
}
if (!globalThis.TextDecoder) {
  // @ts-expect-error - TextDecoder type on Node differs from DOM lib
  globalThis.TextDecoder = TextDecoder;
}
import { StockDetailsSchema } from "~/gen/stocks/v1alpha1/stocks_pb";
import {
  getEnrichedCompanyMetadata,
  hasEnrichedData,
} from "../company-metadata";

jest.mock("@connectrpc/connect-web", () => ({
  createConnectTransport: jest.fn(() => ({})),
}));

jest.mock("@connectrpc/connect", () => {
  const mockClient = {
    getStockDetails: jest.fn(),
  };
  return {
    createClient: jest.fn(() => mockClient),
    MethodKind: {
      Unary: "unary",
    },
    __mockClient: mockClient,
  };
});

const { __mockClient: mockClient } = jest.requireMock("@connectrpc/connect") as {
  __mockClient: {
    getStockDetails: jest.Mock;
  };
};

describe("company-metadata actions", () => {
  beforeEach(() => {
    mockClient.getStockDetails.mockReset();
  });

  const buildStockDetails = () =>
    create(StockDetailsSchema, {
      productCode: "WES",
      companyName: "WESFARMERS LIMITED",
      industry: "Retail",
      summary: "Base summary",
      gcsUrl: "https://storage.googleapis.com/logos/WES.svg",
      website: "https://www.wesfarmers.com.au",
      tags: ["conglomerate", "retail", "home improvement"],
      enhancedSummary: "Wesfarmers is a major Australian conglomerate...",
      companyHistory: "Founded in 1914...",
      keyPeople: [
        {
          name: "Rob Scott",
          role: "Managing Director & CEO",
          bio: "Joined Wesfarmers in 1993...",
        },
      ],
      financialReports: [
        {
          title: "Annual Report",
          url: "https://example.com/report.pdf",
          type: "annual_report",
          date: "2024-06-30",
          source: "smart_crawler",
        },
      ],
      competitiveAdvantages: "Strong market position...",
      riskFactors: ["Market volatility", "Regulatory changes"],
      recentDevelopments: "Recent expansion...",
      socialMediaLinks: { linkedin: "https://linkedin.com/company/wesfarmers" },
      financialStatements: {
        success: true,
        annual: {
          incomeStatement: {
            "2023-06-30": {
              metrics: { "Total Revenue": 100 },
            },
          },
        },
      },
      enrichmentStatus: "completed",
    });

  describe("getEnrichedCompanyMetadata", () => {
    it("returns mapped metadata when backend responds", async () => {
      const response = buildStockDetails();
      response.enrichmentDate = {
        seconds: BigInt(1_700_000_000),
        nanos: 0,
      };
      mockClient.getStockDetails.mockResolvedValueOnce(response);

      const result = await getEnrichedCompanyMetadata("WES");

      expect(result).toMatchObject({
        stock_code: "WES",
        company_name: "WESFARMERS LIMITED",
        tags: ["conglomerate", "retail", "home improvement"],
        key_people: [
          {
            name: "Rob Scott",
            role: "Managing Director & CEO",
            bio: "Joined Wesfarmers in 1993...",
          },
        ],
        social_media_links: {
          linkedin: "https://linkedin.com/company/wesfarmers",
        },
        enrichment_status: "completed",
      });
      expect(result?.financial_reports?.[0]).toMatchObject({
        title: "Annual Report",
        url: "https://example.com/report.pdf",
        type: "annual_report",
      });
      expect(mockClient.getStockDetails).toHaveBeenCalledWith({
        productCode: "WES",
      });
    });

    it("returns null when backend throws", async () => {
      mockClient.getStockDetails.mockRejectedValueOnce(
        new Error("Upstream unavailable"),
      );
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const result = await getEnrichedCompanyMetadata("WES");

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("hasEnrichedData", () => {
    it("returns true when enrichment_status is completed", async () => {
      const response = buildStockDetails();
      mockClient.getStockDetails.mockResolvedValueOnce(response);

      const result = await hasEnrichedData("WES");

      expect(result).toBe(true);
    });

    it("returns false when enrichment_status is pending", async () => {
      const response = buildStockDetails();
      response.enrichmentStatus = "pending";
      mockClient.getStockDetails.mockResolvedValueOnce(response);

      const result = await hasEnrichedData("WES");

      expect(result).toBe(false);
    });

    it("returns false when backend call fails", async () => {
      mockClient.getStockDetails.mockRejectedValueOnce(
        new Error("network failure"),
      );
      const consoleSpy = jest.spyOn(console, "error").mockImplementation(() => {});

      const result = await hasEnrichedData("WES");

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});