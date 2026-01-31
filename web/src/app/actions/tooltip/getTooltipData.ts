"use server";

import { getOrSetCached, CACHE_KEYS, TOOLTIP_TTL } from "~/@/lib/kv-cache";
import { getStockDetails } from "../getStockDetails";
import { getStockData } from "../getStockData";
import { toJson } from "@bufbuild/protobuf";
import {
  StockDetailsSchema,
  TimeSeriesDataSchema,
} from "~/gen/stocks/v1alpha1/stocks_pb";

/**
 * Serialized stock details for caching (plain object format)
 */
export interface SerializedStockDetails {
  productCode: string;
  companyName: string;
  industry: string;
  address: string;
  summary: string;
  details: string;
  website: string;
  gcsUrl: string;
  tags: string[];
  enhancedSummary: string;
  companyHistory: string;
  keyPeople: Array<{ name: string; role: string; bio: string }>;
  financialReports: Array<{
    url: string;
    title: string;
    type: string;
    date: string;
    source: string;
    gcsUrl: string;
  }>;
  competitiveAdvantages: string;
  riskFactors: string[];
  recentDevelopments: string;
  socialMediaLinks?: {
    twitter: string;
    linkedin: string;
    facebook: string;
    youtube: string;
    website: string;
  };
  enrichmentStatus: string;
  enrichmentDate?: string;
  enrichmentError: string;
  financialStatements?: {
    success: string;
    annual?: Record<string, unknown>;
    quarterly?: Record<string, unknown>;
    info?: {
      marketCap: number;
      currentPrice: number;
      peRatio: number;
      eps: number;
      dividendYield: number;
      beta: number;
      week52High: number;
      week52Low: number;
      volume: number;
      employeeCount: string; // bigint serialized as string
      sector: string;
      industry: string;
    };
    error: string;
  };
  logoGcsUrl: string;
  logoIconGcsUrl: string;
  logoSvgGcsUrl: string;
  logoSourceUrl: string;
  logoFormat: string;
}

/**
 * Serialized time series point for caching
 */
export interface SerializedTimeSeriesPoint {
  timestamp?: string; // ISO string
  shortPosition: number;
}

/**
 * Serialized time series data for caching
 */
export interface SerializedTimeSeriesData {
  productCode: string;
  name: string;
  latestShortPosition: number;
  points: SerializedTimeSeriesPoint[];
  max?: SerializedTimeSeriesPoint;
  min?: SerializedTimeSeriesPoint;
}

/**
 * Combined tooltip data returned from server action
 */
export interface TooltipData {
  stockDetails: SerializedStockDetails | null;
  timeSeriesData: SerializedTimeSeriesData | null;
}

/**
 * Fetches tooltip data for a stock with Redis caching.
 * Combines getStockDetails and getStockData calls into a single cached response.
 *
 * @param productCode - The stock code (e.g., "CBA", "BHP")
 * @returns Combined stock details and time series data, or null values if not found
 */
export async function getTooltipData(
  productCode: string
): Promise<TooltipData> {
  const cacheKey = CACHE_KEYS.tooltipData(productCode);

  return getOrSetCached(
    cacheKey,
    async () => {
      // Fetch both in parallel
      const [details, tsData] = await Promise.all([
        getStockDetails(productCode).catch(() => null),
        getStockData(productCode, "1m").catch(() => null),
      ]);

      // Serialize protobuf messages to plain JSON objects for caching
      const serializedDetails = details
        ? (toJson(StockDetailsSchema, details) as unknown as SerializedStockDetails)
        : null;

      const serializedTsData = tsData
        ? (toJson(TimeSeriesDataSchema, tsData) as unknown as SerializedTimeSeriesData)
        : null;

      return {
        stockDetails: serializedDetails,
        timeSeriesData: serializedTsData,
      };
    },
    TOOLTIP_TTL
  );
}
