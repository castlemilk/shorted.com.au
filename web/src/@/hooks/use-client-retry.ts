"use client";

import { useState, useEffect, useCallback } from "react";
import { retryWithBackoff, type RetryOptions } from "@/lib/retry";

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
  } = options;

  const [data, setData] = useState<T | null>(initialData);
  const [isLoading, setIsLoading] = useState(!initialData && fetchOnMount);
  const [error, setError] = useState<Error | null>(null);
  const [isRetrying, setIsRetrying] = useState(false);

  const doFetch = useCallback(async (isManualRetry = false) => {
    if (isManualRetry) {
      setIsRetrying(true);
    } else {
      setIsLoading(true);
    }
    setError(null);

    try {
      const result = await retryWithBackoff(fetchFn, {
        maxRetries,
        initialDelayMs,
        maxDelayMs,
        backoffMultiplier,
      });
      setData(result);
      onSuccess?.(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error);
      onError?.(error);
      console.error("Client retry failed after all attempts:", error);
    } finally {
      setIsLoading(false);
      setIsRetrying(false);
    }
  }, [fetchFn, maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier, onSuccess, onError]);

  // Fetch on mount if no initial data
  useEffect(() => {
    if (!initialData && fetchOnMount) {
      void doFetch();
    }
    // Intentionally empty deps - only run on mount
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
  };
}
