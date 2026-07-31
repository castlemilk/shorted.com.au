"use server";

/**
 * The /politicians hub table's data path.
 *
 * WHY A SEPARATE `"use server"` MODULE. `getPoliticians.ts` is a plain server
 * module — its exports are `cache(withRetryAndNotFound(...))` wrappers, not bare
 * async functions, so it cannot carry the directive. This file is the thin
 * action layer the hub's client island is handed as a prop, and it is the ONLY
 * place the protobuf messages are turned into plain JSON.
 *
 * WHY THE MAPPING HAPPENS HERE. Register messages carry `google.protobuf.
 * Timestamp`s, which are BigInt-backed and make `JSON.stringify` throw, and the
 * generated types carry a `$typeName` with no business crossing the RSC
 * boundary. The client island therefore never sees a proto — only the plain
 * row shape it declares.
 *
 * The same function serves the server page's first render and the island's
 * re-queries, so the two can never drift into rendering different shapes.
 */

import {
  clampPoliticianSummaryQuery,
  listPoliticianSummaries,
  type PoliticianSummaryQuery,
} from "./getPoliticians";
import type {
  PoliticianTablePage,
  PoliticianTableQuery,
  PoliticianTableRow,
} from "@/components/politicians/politician-register-table";

/** Proto summary -> plain row. Counts only; there is no amount to carry. */
function toRow(summary: {
  politician?: {
    slug: string;
    displayName: string;
    partyAb: string;
    chamber: string;
    division: string;
    stateCode: string;
    photoUrl: string;
    photoLicence: string;
    photoAuthor: string;
    photoSourceUrl: string;
  };
  itemCounts: { itemNo: number; currentCount: number }[];
  distinctCompanyCount: number;
  propertyCount: number;
  giftsTravelCount: number;
  changes90d: number;
  undatedCount: number;
  trend: { month: string; declaredCount: number }[];
}): PoliticianTableRow | null {
  const politician = summary.politician;
  // A summary with no politician cannot be attributed to anyone, so it is
  // dropped rather than rendered against a blank name.
  if (!politician?.slug) return null;
  return {
    slug: politician.slug,
    displayName: politician.displayName,
    partyAb: politician.partyAb,
    chamber: politician.chamber,
    division: politician.division,
    stateCode: politician.stateCode,
    // "Declared entries" is the sum of the fourteen register items as they
    // currently stand — the same expression the backend sorts on.
    declaredItems: (summary.itemCounts ?? []).reduce(
      (total, item) => total + Number(item.currentCount ?? 0),
      0,
    ),
    companies: Number(summary.distinctCompanyCount ?? 0),
    // Currently-declared item-3 ENTRIES. Not a property tally: a single entry
    // frequently lists more than one address, so this is a floor and every
    // surface labels it as entries.
    realEstateEntries: Number(summary.propertyCount ?? 0),
    giftsTravel: Number(summary.giftsTravelCount ?? 0),
    changes90d: Number(summary.changes90d ?? 0),
    undatedCount: Number(summary.undatedCount ?? 0),
    trend: (summary.trend ?? []).map((point) => ({
      month: point.month,
      count: Number(point.declaredCount ?? 0),
    })),
    photoUrl: politician.photoUrl ?? "",
    photoLicence: politician.photoLicence ?? "",
    photoAuthor: politician.photoAuthor ?? "",
    photoSourceUrl: politician.photoSourceUrl ?? "",
  };
}

function toTableQuery(query: PoliticianSummaryQuery): PoliticianTableQuery {
  return {
    chamber: query.chamber,
    stateCode: query.stateCode,
    partyAb: query.partyAb,
    itemNo: query.itemNo,
    sort: query.sort,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * One page of the hub table.
 *
 * TAKES A PARTIAL QUERY, and clamps it into a full one. That is what lets the
 * server page ask for the first page without importing a default constant out
 * of the client island — a server component that reads a plain value from a
 * "use client" module gets a client-reference proxy and throws on the first
 * property access, at prerender time, where neither jest nor tsc can see it.
 *
 * NEVER THROWS. It is awaited by the static page's own render, so a failed fetch
 * must degrade to an empty page rather than take the route down; the island
 * words its empty state according to whether a filter is active, so an outage
 * with no filters set does not read as "no member declares anything".
 *
 * The echoed `query` is the CLAMPED one, so the island's controls always show
 * what the server actually ran.
 */
export async function loadPoliticianTable(
  input: Partial<PoliticianTableQuery> = {},
): Promise<PoliticianTablePage> {
  const query = clampPoliticianSummaryQuery(input);
  const echo = toTableQuery(query);
  const resp = await listPoliticianSummaries(query);
  if (!resp) return { rows: [], total: 0, query: echo };

  const rows = (resp.summaries ?? [])
    .map(toRow)
    .filter((row): row is PoliticianTableRow => row !== null);
  return { rows, total: Number(resp.total ?? 0), query: echo };
}
