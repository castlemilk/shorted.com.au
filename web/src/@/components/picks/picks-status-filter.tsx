"use client";

import { useSearchParams } from "next/navigation";

import { parsePickStatus } from "~/@/lib/strategies/shortlist";
import { PicksFilterView, type PicksFilterViewProps } from "./picks-filter-view";

/**
 * The client island behind the `?status=` filter.
 *
 * It reads the query string with useSearchParams, which suspends on a static
 * page, so the page MUST mount it under a real <Suspense> boundary whose
 * fallback is <PicksFilterView status={null}>: that fallback is what lands in
 * the ISR HTML. Reading searchParams in the server page instead would silently
 * force the route dynamic and throw the ISR away.
 *
 * The server hands over every fetched row (max 100, plain serialisable data);
 * filtering happens here, with no further request.
 */
export function PicksStatusFilter(props: Omit<PicksFilterViewProps, "status">) {
  const searchParams = useSearchParams();
  const status = parsePickStatus(searchParams?.get("status"));
  return <PicksFilterView {...props} status={status} />;
}
