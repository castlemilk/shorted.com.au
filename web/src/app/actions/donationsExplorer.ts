"use server";

/**
 * The /politicians/donations explorer's data path.
 *
 * WHY A SEPARATE `"use server"` MODULE. `getDonations.ts` is a plain server
 * module — its exports are `cache(withRetryAndNotFound(...))` wrappers, not bare
 * async functions, so it cannot carry the directive. This file is the thin
 * action layer the client island is handed as a prop, and it is the ONLY place
 * the protobuf messages become plain JSON.
 *
 * WHY THE MAPPING HAPPENS HERE. Funding messages carry `google.protobuf
 * .Timestamp`s AND int64 amounts. Both are BigInt-backed, so `JSON.stringify`
 * throws on either, and the generated types carry a `$typeName` with no business
 * crossing the RSC boundary. The island therefore never sees a proto — only the
 * plain row shapes it declares.
 *
 * The same function serves the server page's first render and the island's
 * re-queries, so the two can never drift into rendering different shapes.
 *
 * THE ORDER MATTERS, TWICE OVER.
 *
 *   1. The OVERVIEW runs first because it is the authority on the year. An empty
 *      `financial_year` asks for "the latest year held" and the backend resolves
 *      it, so the payer list is then requested for the year the overview
 *      actually served — not for the empty string, which each rpc would resolve
 *      independently and could resolve differently the moment an ingest lands
 *      between two calls.
 *   2. The LISTED-COMPANY rail fans out over the party groups the overview says
 *      hold listed payers at all. It cannot be filtered out of the payer page:
 *      only 6 of the 90 listed payers in FY2024-25 fall inside the top 200 by
 *      amount, so a filtered payer page would have published six companies under
 *      a heading claiming to cover the listed ones. Three or four groups hold
 *      listed payers in every year measured, so the fan-out is small and
 *      bounded — and the groups it covers are NAMED on the surface rather than
 *      implied, with any group it did not reach counted out loud.
 */

import {
  DONORS_PAGE_SIZE,
  OVERVIEW_PARTY_LIMIT,
  PARTY_PAYER_LIMIT,
  clampFinancialYear,
  clampTopDonorsQuery,
  getDonationsOverview,
  listPartyFunding,
  listTopDonors,
} from "./getDonations";
import { toDate } from "@/lib/politics/timestamp";
import { addReceiptSplits, EMPTY_RECEIPT_SPLIT } from "@/lib/politics/funding-money";
import type { ReceiptSplitCents } from "@/lib/politics/funding-money";
import type {
  DonationsPage,
  DonationsQuery,
  PayerRow,
} from "@/components/politicians/donations-explorer";
import type {
  PartyFundingSummary,
  TopDonor,
} from "~/gen/shorts/v1alpha1/politicians_pb";

/**
 * How many party groups the listed-company rail will fan out over.
 *
 * Three or four groups hold a listed payer in every financial year measured, so
 * this is headroom rather than a real cut — but it is a HARD cap, because the
 * fan-out is one rpc per group and an unbounded one would turn a bad ingest into
 * a hundred requests per render. Whatever it drops is counted and stated.
 */
const LISTED_GROUP_FANOUT = 6;

/** How many matched payers the rail renders. The rest are counted, not hidden. */
const LISTED_PAYER_ROWS = 24;

/**
 * Normalise a partial query into the one the server will actually run.
 *
 * Exported for the server page, which asks for the default view without
 * importing a default constant out of the `"use client"` island — a server
 * component that reads a plain value from a client module gets a
 * client-reference proxy and throws on the first property access, at prerender
 * time, where neither jest nor tsc can see it.
 */
export async function clampDonationsQuery(
  input: Partial<DonationsQuery> = {},
): Promise<DonationsQuery> {
  const donors = clampTopDonorsQuery({
    financialYear: input.financialYear,
    partyGroup: input.partyGroup,
    limit: input.limit ?? DONORS_PAGE_SIZE,
    offset: input.offset,
  });
  return {
    financialYear: donors.financialYear,
    partyGroup: donors.partyGroup,
    limit: donors.limit,
    offset: donors.offset,
  };
}

/** int64 arrives as bigint; the RSC boundary takes numbers. */
function cents(value: bigint | number | undefined): number {
  if (value === undefined) return 0;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) ? asNumber : 0;
}

function splitOf(donor: TopDonor): ReceiptSplitCents {
  const split = donor.receiptTypes;
  if (!split) return { ...EMPTY_RECEIPT_SPLIT };
  return {
    donation: cents(split.donationCents),
    otherReceipt: cents(split.otherReceiptCents),
    subscription: cents(split.subscriptionCents),
    publicFunding: cents(split.publicFundingCents),
    unspecified: cents(split.unspecifiedCents),
  };
}

/**
 * One payer row.
 *
 * The id is the NORMALISED name, which is the key the source's several spellings
 * were grouped by — the verbatim name is not unique within a page and a row key
 * built from it would collide.
 */
function payerRow(donor: TopDonor): PayerRow {
  return {
    id: donor.donorNameNorm || donor.donorName,
    donorName: donor.donorName,
    donorNameNorm: donor.donorNameNorm,
    totalCents: cents(donor.totalCents),
    receiptCount: Number(donor.receiptCount ?? 0),
    split: splitOf(donor),
    recipients: (donor.recipients ?? []).map((recipient) => ({
      partyGroup: recipient.partyGroup,
      amountCents: cents(recipient.amountCents),
    })),
    stockCode: donor.stockCode ?? "",
    companyName: donor.companyName ?? "",
    matchMethod: donor.matchMethod ?? "",
  };
}

function partyRow(party: PartyFundingSummary) {
  return {
    partyGroup: party.partyGroup,
    financialYear: party.financialYear,
    partyReturnCount: Number(party.partyReturnCount ?? 0),
    totalReceiptsCents: cents(party.totalReceiptsCents),
    itemisedReceiptsCents: cents(party.itemisedReceiptsCents),
    declaredDonationsCents: cents(party.declaredDonationsCents),
    distinctPayerCount: Number(party.distinctPayerCount ?? 0),
    distinctDonorCount: Number(party.distinctDonorCount ?? 0),
    listedPayerCount: Number(party.listedPayerCount ?? 0),
    thresholdCensored: !!party.thresholdCensored,
    postReformScheme: !!party.postReformScheme,
  };
}

/**
 * Merge the same company's rows across party groups.
 *
 * THE MERGE KEY IS (stock code, normalised lodged name), not the stock code
 * alone. One listing can be paid in under two different normalised names, and
 * collapsing those would put a verbatim "lodged as" line over a total that
 * includes rows lodged under a different string. Two rows for one company is a
 * fact of the source; one row with a misleading label is not.
 *
 * The amounts summed are all the SAME measure — itemised receipts, scoped to one
 * party group per response — so this is an addition the source itself supports,
 * and the recipient breakdown that comes with it names every group summed.
 */
function mergeListedPayers(byGroup: PayerRow[][]): PayerRow[] {
  const merged = new Map<string, PayerRow>();
  for (const rows of byGroup) {
    for (const row of rows) {
      if (!row.stockCode) continue;
      const key = `${row.stockCode}|${row.donorNameNorm}`;
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, { ...row, id: key, recipients: [...row.recipients] });
        continue;
      }
      existing.totalCents += row.totalCents;
      existing.receiptCount += row.receiptCount;
      existing.split = addReceiptSplits(existing.split, row.split);
      existing.recipients = [...existing.recipients, ...row.recipients];
    }
  }
  return [...merged.values()].sort(
    (a, b) => b.totalCents - a.totalCents || a.stockCode.localeCompare(b.stockCode),
  );
}

/**
 * One view of the funding explorer: the per-party bars, the payer page and the
 * listed-company rail.
 *
 * NEVER THROWS. It is awaited by the static page's own render, so a failed fetch
 * must degrade to an empty view rather than take the route down.
 *
 * WHICH IS WHY IT REPORTS THREE `ok` FLAGS. A failed fetch and a filter nobody
 * matches both arrive as zero rows and mean opposite things: one is our outage,
 * the other is an honest answer about the filter. Collapsing them lets the island
 * word an outage as "no payer is itemised under this party group" — a false
 * absence claim about a named party, published on our own downtime. The three
 * are separate because the three rpcs fail independently: a dead listed-payer
 * fan-out must not blank a healthy payer table.
 */
export async function loadDonationsExplorer(
  input: Partial<DonationsQuery> = {},
): Promise<DonationsPage> {
  const query = await clampDonationsQuery(input);

  const overview = await getDonationsOverview(query.financialYear, OVERVIEW_PARTY_LIMIT).catch(
    () => undefined,
  );

  // The year the OVERVIEW served, which is what every later request is pinned
  // to. See the file docblock: resolving "" independently in three rpcs lets an
  // ingest landing mid-render put two different years on one page.
  const servedYear = clampFinancialYear(overview?.financialYear) || query.financialYear;

  const parties = (overview?.parties ?? []).map(partyRow);

  const payers = await listTopDonors({
    financialYear: servedYear,
    partyGroup: query.partyGroup,
    limit: query.limit,
    offset: query.offset,
  }).catch(() => undefined);

  /*
   * The listed rail's scope.
   *
   * With a party filter set it is that ONE group, because that is what the
   * reader asked about. Unfiltered it is the groups the overview says hold a
   * listed payer at all, largest first — and if there are more of those than the
   * fan-out cap, the remainder is counted so the surface can say so.
   */
  const groupsWithListed = query.partyGroup
    ? [query.partyGroup]
    : parties
        .filter((party) => party.listedPayerCount > 0)
        .map((party) => party.partyGroup);
  const fetchedGroups = groupsWithListed.slice(0, LISTED_GROUP_FANOUT);
  const omittedGroupCount = groupsWithListed.length - fetchedGroups.length;

  const listedResponses = await Promise.all(
    fetchedGroups.map((group) =>
      listPartyFunding(group, servedYear, PARTY_PAYER_LIMIT).catch(() => undefined),
    ),
  );
  // A fan-out is "ok" only when EVERY leg answered: a partial merge renders a
  // company's total across two party groups when three contributed, which is a
  // wrong figure rather than a missing one.
  const listedOk = listedResponses.every((response) => response !== undefined);
  const allListed = mergeListedPayers(
    listedResponses.map((response) =>
      (response?.listedCompanyPayers ?? []).map(payerRow),
    ),
  );

  const notesFrom = overview ?? payers;

  return {
    query: { ...query, financialYear: servedYear },
    financialYear: servedYear,
    years: (overview?.availableFinancialYears ?? []).map((year) => ({
      financialYear: year.financialYear,
      partyGroupCount: Number(year.partyGroupCount ?? 0),
    })),
    parties,
    corpus: overview?.corpus
      ? {
          partyReturnCount: Number(overview.corpus.partyReturnCount ?? 0),
          receiptCount: Number(overview.corpus.receiptCount ?? 0),
          donationMadeCount: Number(overview.corpus.donationMadeCount ?? 0),
          mpReturnCount: Number(overview.corpus.mpReturnCount ?? 0),
          mpReturnResolvedCount: Number(overview.corpus.mpReturnResolvedCount ?? 0),
          candidateReturnCount: Number(overview.corpus.candidateReturnCount ?? 0),
          candidateReturnResolvedCount: Number(
            overview.corpus.candidateReturnResolvedCount ?? 0,
          ),
          nilCandidateReturnCount: Number(overview.corpus.nilCandidateReturnCount ?? 0),
          candidateDonationCount: Number(overview.corpus.candidateDonationCount ?? 0),
          firstFinancialYearEnd: Number(overview.corpus.firstFinancialYearEnd ?? 0),
          lastFinancialYearEnd: Number(overview.corpus.lastFinancialYearEnd ?? 0),
          matchedPayerNameCount: Number(overview.corpus.matchedPayerNameCount ?? 0),
        }
      : undefined,
    payers: (payers?.donors ?? []).map(payerRow),
    payerTotal: Number(payers?.total ?? 0),
    payerFinancialYear: payers?.financialYear ?? servedYear,
    listedPayers: allListed.slice(0, LISTED_PAYER_ROWS),
    listedGroups: fetchedGroups,
    listedOmittedGroupCount: Math.max(0, omittedGroupCount),
    listedTotal: allListed.length,
    // EVERY note comes off the wire. The API is the single source for this copy
    // precisely so no surface can paraphrase a caveat into a claim; an empty
    // string here means the request did not answer, and the band renders nothing
    // rather than a caveat we made up.
    notes: {
      censoring: notesFrom?.censoringNote ?? "",
      reform: notesFrom?.reformNote ?? "",
      coverage: overview?.coverageNote ?? "",
      verbatim: notesFrom?.verbatimNote ?? "",
      donorScope: payers?.scopeNote ?? "",
      attribution: notesFrom?.attribution ?? "",
      licence: notesFrom?.sourceLicence ?? "",
    },
    asAt: (toDate(overview?.asAt) ?? toDate(payers?.asAt))?.toISOString() ?? "",
    // `undefined` is the retry helper's exhausted/not-found signal: the request
    // did not answer. A genuinely empty result comes back as a RESPONSE carrying
    // no rows and reaches `ok: true` with zero of them — which is what lets the
    // island tell the two apart.
    overviewOk: overview !== undefined,
    payersOk: payers !== undefined,
    listedOk,
  };
}
