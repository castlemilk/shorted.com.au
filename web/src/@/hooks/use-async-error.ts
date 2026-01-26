"use client";

import { useCallback, useState } from "react";

/**
 * Hook to handle async errors that occur outside of render
 * Useful for catching errors in async operations like data fetching
 */
export function useAsyncError() {
  const [, setError] = useState();

  return useCallback(
    (error: Error) => {
      setError(() => {
        throw error;
      });
    },
    [setError]
  );
}

/**
 * Wrapper for async operations that propagates errors to error boundaries
 */
export function useAsyncErrorHandler() {
  const throwError = useAsyncError();

  return useCallback(
    async <T,>(asyncOperation: () => Promise<T>): Promise<T | null> => {
      try {
        return await asyncOperation();
      } catch (error) {
        throwError(error instanceof Error ? error : new Error(String(error)));
        return null;
      }
    },
    [throwError]
  );
}