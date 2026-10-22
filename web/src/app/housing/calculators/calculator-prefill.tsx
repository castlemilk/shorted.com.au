"use client";

import { useSearchParams } from "next/navigation";

import { CalculatorSet, PrefillNote } from "./calculator-set";
import { resolvePrefill } from "./prefill";

/*
 * The query-dependent parts of /housing/calculators, read in the browser.
 * useSearchParams suspends a static page to the nearest Suspense boundary, so
 * each of these sits under a real <Suspense> on the page whose fallback is the
 * unprefilled render (a next/dynamic loading fallback does not count). That
 * fallback is what the ISR HTML carries; the prefill lands on hydration.
 */

export function QueryPrefillNote({ liveDefault }: { liveDefault: number }) {
  return <PrefillNote prefill={resolvePrefill(useSearchParams(), liveDefault)} />;
}

export function QueryPrefilledCalculators({ liveDefault }: { liveDefault: number }) {
  return <CalculatorSet {...resolvePrefill(useSearchParams(), liveDefault)} />;
}
