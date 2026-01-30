"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface UseWidgetVisibilityOptions {
  /** Root margin for intersection observer (default: "100px") */
  rootMargin?: string;
  /** Threshold for intersection (default: 0.1) */
  threshold?: number;
  /** Delay before marking as visible (default: 0ms) */
  visibilityDelay?: number;
  /** Initial visibility state (default: false) */
  initiallyVisible?: boolean;
}

interface UseWidgetVisibilityReturn {
  /** Ref to attach to the widget container */
  ref: React.RefObject<HTMLDivElement>;
  /** Is the widget currently visible in viewport */
  isVisible: boolean;
  /** Has the widget ever been visible (for lazy loading) */
  hasBeenVisible: boolean;
  /** Manually set visibility (useful for testing) */
  setVisible: (visible: boolean) => void;
}

/**
 * Hook for tracking widget visibility using IntersectionObserver
 * Useful for:
 * - Lazy loading data only when widget is visible
 * - Pausing expensive computations when widget is off-screen
 * - Tracking analytics for widget impressions
 */
export function useWidgetVisibility({
  rootMargin = "100px",
  threshold = 0.1,
  visibilityDelay = 0,
  initiallyVisible = false,
}: UseWidgetVisibilityOptions = {}): UseWidgetVisibilityReturn {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(initiallyVisible);
  const [hasBeenVisible, setHasBeenVisible] = useState(initiallyVisible);

  // Track visibility timeout
  const visibilityTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Manual visibility setter
  const setVisible = useCallback((visible: boolean) => {
    setIsVisible(visible);
    if (visible) {
      setHasBeenVisible(true);
    }
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Check if IntersectionObserver is available
    if (typeof IntersectionObserver === "undefined") {
      // Fallback: assume visible
      setIsVisible(true);
      setHasBeenVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (!entry) return;

        const nowVisible = entry.isIntersecting;

        // Clear any pending visibility timeout
        if (visibilityTimeoutRef.current) {
          clearTimeout(visibilityTimeoutRef.current);
          visibilityTimeoutRef.current = null;
        }

        if (nowVisible) {
          // Apply delay before marking as visible
          if (visibilityDelay > 0) {
            visibilityTimeoutRef.current = setTimeout(() => {
              setIsVisible(true);
              setHasBeenVisible(true);
            }, visibilityDelay);
          } else {
            setIsVisible(true);
            setHasBeenVisible(true);
          }
        } else {
          // Immediately mark as not visible
          setIsVisible(false);
        }
      },
      {
        rootMargin,
        threshold,
      }
    );

    observer.observe(element);

    return () => {
      observer.disconnect();
      if (visibilityTimeoutRef.current) {
        clearTimeout(visibilityTimeoutRef.current);
      }
    };
  }, [rootMargin, threshold, visibilityDelay]);

  return {
    ref,
    isVisible,
    hasBeenVisible,
    setVisible,
  };
}

/**
 * Hook for lazy data fetching based on visibility
 * Only fetches when widget becomes visible
 */
export function useLazyWidgetData<T>(
  fetchFn: () => Promise<T>,
  {
    enabled = true,
    refetchOnVisible = false,
    ...visibilityOptions
  }: UseWidgetVisibilityOptions & {
    enabled?: boolean;
    refetchOnVisible?: boolean;
  } = {}
): {
  visibility: UseWidgetVisibilityReturn;
  data: T | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
} {
  const visibility = useWidgetVisibility(visibilityOptions);
  const [data, setData] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const hasFetchedRef = useRef(false);

  const refetch = useCallback(async () => {
    if (!enabled) return;

    setIsLoading(true);
    setError(null);

    try {
      const result = await fetchFn();
      setData(result);
      hasFetchedRef.current = true;
    } catch (err) {
      setError(err instanceof Error ? err : new Error("Failed to fetch"));
    } finally {
      setIsLoading(false);
    }
  }, [fetchFn, enabled]);

  useEffect(() => {
    // Fetch when widget becomes visible for the first time
    if (visibility.isVisible && enabled) {
      if (!hasFetchedRef.current || refetchOnVisible) {
        void refetch();
      }
    }
  }, [visibility.isVisible, enabled, refetchOnVisible, refetch]);

  return {
    visibility,
    data,
    isLoading,
    error,
    refetch,
  };
}
