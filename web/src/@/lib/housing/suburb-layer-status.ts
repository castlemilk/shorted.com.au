/**
 * Decides which overlay (if any) the drilled-in suburb layer of the housing zoom
 * map should show. Pure + dependency-free so it can be unit-tested without the
 * component's d3 / react-query import graph.
 *
 *  - "national": no state selected — the whole-Australia view, no overlay.
 *  - "ready":    a state is active and its suburbs are built — show the layer.
 *  - "loading":  active, suburbs not ready yet, a fetch is still in flight.
 *  - "error":    active, suburbs not ready, and nothing is in flight (the data
 *                or boundary fetch settled empty/failed) — show a retry affordance.
 */
export type SuburbLayerStatus = "national" | "ready" | "loading" | "error";

export function suburbLayerStatus(
  active: string | null,
  hasSuburb: boolean,
  busy: boolean,
): SuburbLayerStatus {
  if (!active) return "national";
  if (hasSuburb) return "ready";
  return busy ? "loading" : "error";
}
