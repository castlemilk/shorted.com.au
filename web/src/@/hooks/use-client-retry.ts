"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import {
  retryWithBackoff,
  shouldRetryConnectError,
  isRateLimitError,
  parseRateLimitInfo,
  type RetryOptions,
  type RateLimitInfo,
} from "@/lib/retry";

export interface UseClientRetryOptions<T> extends Partial<RetryOptions> {
  /** Initial data from SSR (if available) */
  initialData?: T | null;
  /** Whether to immediately fetch if initialData is null/undefined */
  fetchOnMount?: boolean;
  /** Callback when data is successfully fetched */
  onSuccess?: (data: T) => void;
  /** Callback when all retries fail */
  onError?: (error: Error) => void;
}

export interface UseClientRetryResult<T> {
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  retry: () => void;
  isRetrying: boolean;
  /** Rate limit info if the error is a 429 */
  rateLimitInfo: RateLimitInfo | null;
}

/**
 * Hook for client-side data fetching with retry capability.
 * 
 * Use this when SSR might fail and you want the client to retry.
 * 
 * @example
 * ```tsx
 * function MyComponent({ stockCode, initialData }) {
 *   const { data, isLoading, error, retry } = useClientRetry(
 *     () => fetchStockDetails(stockCode),
 *     { initialData, fetchOnMount: !initialData }
 *   );
 *   
 *   if (isLoading) return <Skeleton />;
 *   if (error) return <RetryButton onClick={retry} />;
 *   if (!data) return <EmptyState />;
 *   return <DataDisplay data={data} />;
 * }
 * ```
 */
export function useClientRetry<T>(
  fetchFn: () => Promise<T>,
  options: UseClientRetryOptions<T> = {},
): UseClientRetryResult<T> {
  const {
    initialData = null,
    fetchOnMount = true,
    onSuccess,
    onError,
    maxRetries = 3,
    initialDelayMs = 1000,
    maxDelayMs = 10000,
    backoffMultiplier = 2,
    shouldRetry = shouldRetryConnectError,
  } = options;

  const [data, setData] = useState<T | null>(initialData);
  const [isLoading, setIsLoading] = useState(!initialData && fetchOnMount);
  const [error, setError] = useState<Error | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);
  const [rateLimitInfo, setRateLimitInfo] = useState<RateLimitInfo | null>(null);

  // Store fetchFn in a ref to avoid triggering re-renders when it changes
  // This is critical because parent components often pass inline arrow functions
  const fetchFnRef = useRef(fetchFn);
  useEffect(() => {
    fetchFnRef.current = fetchFn;
  }, [fetchFn]);

  // Store callbacks in refs to avoid dependency issues
  const onSuccessRef = useRef(onSuccess);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onSuccessRef.current = onSuccess;
    onErrorRef.current = onError;
  }, [onSuccess, onError]);

  // Track whether we've already run the initial fetch to prevent re-runs
  const hasRunInitialFetch = useRef(false);

  const doFetch = useCallback(async (isManualRetry = false) => {
    if (isManualRetry) {
      setIsRetrying(true);
    } else {
      setIsLoading(true);
    }
    setError(null);
    setRateLimitInfo(null);

    try {
      const result = await retryWithBackoff(fetchFnRef.current, {
        maxRetries,
        initialDelayMs,
        maxDelayMs,
        backoffMultiplier,
        shouldRetry,
      });
      setData(result);
      onSuccessRef.current?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);

      // Extract rate limit info if applicable
      if (isRateLimitError(err)) {
        const info = parseRateLimitInfo(err);
        setRateLimitInfo(info);
        console.warn("Rate limit exceeded:", info);
      }

      onErrorRef.current?.(error);
      console.error("Client retry failed after all attempts:", error);
    } finally {
      setIsLoading(false);
      setIsRetrying(false);
    }
  }, [maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier, shouldRetry]);

  // Fetch on mount if no initial data - uses ref guard to ensure single execution
  useEffect(() => {
    if (!initialData && fetchOnMount && !hasRunInitialFetch.current) {
      hasRunInitialFetch.current = true;
      void doFetch();
    }
  }, [initialData, fetchOnMount, doFetch]);

  const retry = useCallback(() => {
    void doFetch(true);
  }, [doFetch]);

  return {
    data,
    isLoading,
    error,
    retry,
    isRetrying,
    rateLimitInfo,
  };
}
