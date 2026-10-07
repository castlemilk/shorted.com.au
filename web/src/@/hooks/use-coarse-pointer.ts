"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(pointer: coarse)";

const noopUnsubscribe = (): void => undefined;

function getMql(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(QUERY);
}

function subscribe(onChange: () => void): () => void {
  const mql = getMql();
  if (!mql) return noopUnsubscribe;
  // Safari < 14 only has the deprecated addListener API.
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

const getSnapshot = () => getMql()?.matches ?? false;
const getServerSnapshot = () => false;

/**
 * True when the PRIMARY pointer is coarse (a finger). SSR-safe: `false` on the
 * server and wherever `matchMedia` is missing, then follows media changes
 * (e.g. a tablet docking a trackpad).
 *
 * Use it for presentation choices only (where to place a tooltip). Touch
 * handling itself must not depend on it — a laptop with a touchscreen reports
 * a fine primary pointer but still delivers touch events.
 */
export function useCoarsePointer(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
