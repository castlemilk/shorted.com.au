"use client";

import { useState, useEffect, useMemo } from "react";

// Breakpoints matching Tailwind CSS defaults
const breakpoints = {
  xxs: 0,
  xs: 480,
  sm: 640,
  md: 768,
  lg: 1024,
  xl: 1280,
  "2xl": 1536,
} as const;

type Breakpoint = keyof typeof breakpoints;

interface UseBreakpointReturn {
  /** Current breakpoint name */
  breakpoint: Breakpoint;
  /** Screen width in pixels */
  width: number;
  /** Is mobile (xxs, xs, sm) */
  isMobile: boolean;
  /** Is tablet (md) */
  isTablet: boolean;
  /** Is desktop (lg, xl, 2xl) */
  isDesktop: boolean;
  /** Is touch device */
  isTouch: boolean;
  /** Check if current width is at least the given breakpoint */
  isAtLeast: (bp: Breakpoint) => boolean;
  /** Check if current width is at most the given breakpoint */
  isAtMost: (bp: Breakpoint) => boolean;
}

function getBreakpoint(width: number): Breakpoint {
  if (width >= breakpoints["2xl"]) return "2xl";
  if (width >= breakpoints.xl) return "xl";
  if (width >= breakpoints.lg) return "lg";
  if (width >= breakpoints.md) return "md";
  if (width >= breakpoints.sm) return "sm";
  if (width >= breakpoints.xs) return "xs";
  return "xxs";
}

export function useBreakpoint(): UseBreakpointReturn {
  const [width, setWidth] = useState<number>(
    typeof window !== "undefined" ? window.innerWidth : 1024
  );

  const [isTouch, setIsTouch] = useState<boolean>(
    typeof window !== "undefined"
      ? "ontouchstart" in window || navigator.maxTouchPoints > 0
      : false
  );

  useEffect(() => {
    // Set initial values
    setWidth(window.innerWidth);
    setIsTouch("ontouchstart" in window || navigator.maxTouchPoints > 0);

    let timeoutId: NodeJS.Timeout;

    const handleResize = () => {
      // Debounce resize handler
      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setWidth(window.innerWidth);
      }, 100);
    };

    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      clearTimeout(timeoutId);
    };
  }, []);

  const breakpoint = useMemo(() => getBreakpoint(width), [width]);

  const isMobile = useMemo(
    () => breakpoint === "xxs" || breakpoint === "xs" || breakpoint === "sm",
    [breakpoint]
  );

  const isTablet = useMemo(() => breakpoint === "md", [breakpoint]);

  const isDesktop = useMemo(
    () => breakpoint === "lg" || breakpoint === "xl" || breakpoint === "2xl",
    [breakpoint]
  );

  const isAtLeast = useMemo(
    () => (bp: Breakpoint) => width >= breakpoints[bp],
    [width]
  );

  const isAtMost = useMemo(
    () => (bp: Breakpoint) => width < breakpoints[bp],
    [width]
  );

  return {
    breakpoint,
    width,
    isMobile,
    isTablet,
    isDesktop,
    isTouch,
    isAtLeast,
    isAtMost,
  };
}

/**
 * Hook to get a value based on current breakpoint
 */
export function useBreakpointValue<T>(
  values: Partial<Record<Breakpoint, T>>,
  defaultValue: T
): T {
  const { breakpoint } = useBreakpoint();

  return useMemo(() => {
    // Find the value for current breakpoint or fall back to smaller breakpoints
    const breakpointOrder: Breakpoint[] = ["xxs", "xs", "sm", "md", "lg", "xl", "2xl"];
    const currentIndex = breakpointOrder.indexOf(breakpoint);

    // Check from current breakpoint down to find a defined value
    for (let i = currentIndex; i >= 0; i--) {
      const bp = breakpointOrder[i]!;
      if (bp in values && values[bp] !== undefined) {
        return values[bp]!;
      }
    }

    return defaultValue;
  }, [breakpoint, values, defaultValue]);
}
