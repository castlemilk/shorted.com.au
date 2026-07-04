import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_pb";
import { type GetCompanyTaxProfileResponse } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "../config";
import { retryWithBackoff } from "@/lib/retry";
import { getSessionCached, setSessionCached } from "@/lib/session-cache";

const RETRY_OPTIONS = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
};

/**
 * Client-side version of getCompanyTaxProfile.
 * Calls the backend API directly from the browser.
 * Uses sessionStorage cache (5-min TTL) to avoid redundant fetches.
 * Includes retry logic for transient failures.
 */
export const getCompanyTaxProfileClient = async (
  productCode: string,
  forceRefresh = false,
): Promise<GetCompanyTaxProfileResponse> => {
  const cacheKey = `company-tax:${productCode}`;

  if (!forceRefresh) {
    const cached = getSessionCached<GetCompanyTaxProfileResponse>(cacheKey);
    if (cached) return cached;
  }

  // Use relative URL so requests go through Next.js rewrites (avoids CORS).
  const transport = createConnectTransport({
    baseUrl: typeof window !== "undefined" ? "" : SHORTS_API_URL,
  });

  const client = createClient(ShortedStocksService, transport);

  const result = await retryWithBackoff(
    () => client.getCompanyTaxProfile({ productCode }),
    RETRY_OPTIONS,
  );

  setSessionCached(cacheKey, result);
  return result;
};
