"use client";

/**
 * The AEC funding explorer — what parties declared receiving, who the payers
 * were, and which of them are listed companies.
 *
 * WHY A CLIENT ISLAND ON A STATIC PAGE. /politicians/donations is an ISR route
 * and the page must not read `searchParams` (the documented trap that flips a
 * route to dynamic and kills the ISR). So the server page renders the DEFAULT
 * year's bars, payer table and listed-company rail into the HTML — a crawler and
 * a reader with JavaScript off get the real thing — and every filter change is a
 * server-action call from here.
 *
 * WHY THE ACTION ARRIVES AS A PROP. A "use client" politician file may not reach
 * the generated protobuf module through ANY import path (`client-boundary.test
 * .ts` walks the graph). Importing the action module here would reach
 * `getDonations.ts` and therefore `~/gen/…`, so the page passes the action down
 * — which also makes the fetch behaviour trivially mockable.
 *
 * EDITORIAL. This surface publishes AMOUNTS, which every register surface is
 * forbidden from doing, because the two data sets are different things: the
 * registers record what is held and never how much, while the AEC Transparency
 * Register publishes lodged funding figures under CC BY 4.0. What binds here
 * instead:
 *
 *   - RIGHT-CENSORING IS THE FIRST THING A READER MUST KNOW. Amounts below the
 *     year's disclosure threshold are absent from the source, so a small total
 *     is a disclosure fact and not a funding fact. The note is served with the
 *     data and rendered beside the figures, never restated in our own words.
 *   - THE LEDGER SIDES ARE NEVER STACKED. A party's own return, the receipts its
 *     branches itemised and the donations donors declared giving it are three
 *     measures lodged on three forms by different people. They do not reconcile.
 *     One chart per measure, each naming its measure, and nothing is summed
 *     across them.
 *   - A SUBSCRIPTION IS NOT A DONATION. Wherever receipts aggregate, the
 *     source's own five receipt types are shown.
 *   - FIGURES ARE VERBATIM AS LODGED, including the oddities — one minor party's
 *     FY2024-25 receipts really are what its return says. We do not correct
 *     returns, and the served note says so.
 *   - No causal or influence vocabulary anywhere, including aria-labels. The
 *     ordering is by an amount the AEC published; nothing here scores a payer.
 *   - Amber and party colours only. No green, no red, no warning glyphs.
 */

import Link from "next/link";
import { useCallback, useId, useRef, useState } from "react";

import {
  FundingBars,
  donorCountLabel,
  payerCountLabel,
  returnCountLabel,
  type FundingBarRow,
} from "@/components/politicians/explorer/funding-bars";
import {
  RECEIPT_SPLIT_NOTE,
  ReceiptSplit,
} from "@/components/politicians/explorer/receipt-split";
import {
  formatCents,
  formatCount,
  type ReceiptSplitCents,
} from "@/lib/politics/funding-money";
import { partyGroupColor } from "@/lib/politics/party-group-palette";

/* ------------------------------------------------------------------ shapes */

/**
 * The filter state, which is also exactly what the server action accepts.
 *
 * Plain and serialisable by construction: the action maps the protobuf response
 * into these shapes server-side, because funding messages carry Timestamps AND
 * int64 amounts — both BigInt-backed, so `JSON.stringify` throws on either — and
 * a `$typeName` that has no business crossing the RSC boundary.
 */
export interface DonationsQuery {
  /** A verbatim FY label ('2024-25'). Empty asks for the latest year held. */
  financialYear: string;
  /** The source's own party group key. Empty is every group. */
  partyGroup: string;
  limit: number;
  offset: number;
}

export interface PartyFundingRow {
  partyGroup: string;
  financialYear: string;
  partyReturnCount: number;
  /** The party's OWN annual return. */
  totalReceiptsCents: number;
  /** The recipient-declared transaction rows. */
  itemisedReceiptsCents: number;
  /** The donor-declared transaction rows. */
  declaredDonationsCents: number;
  distinctPayerCount: number;
  distinctDonorCount: number;
  listedPayerCount: number;
  thresholdCensored: boolean;
  postReformScheme: boolean;
}

export interface FinancialYearRow {
  financialYear: string;
  partyGroupCount: number;
  /**
   * Party groups in this year holding a payer matched to an ASX listing, over
   * EVERY group in the year — not over the page of groups a response carried.
   * Zero means the API did not serve the figure, which the surface states rather
   * than counting from the page it happens to hold.
   */
  listedGroupCount: number;
}

export interface PayerRecipientRow {
  partyGroup: string;
  amountCents: number;
}

export interface PayerRow {
  /** Stable within a page: the normalised key the spellings were grouped by. */
  id: string;
  /** VERBATIM as lodged. The source is unnormalised; we do not tidy names. */
  donorName: string;
  donorNameNorm: string;
  totalCents: number;
  receiptCount: number;
  split: ReceiptSplitCents;
  recipients: PayerRecipientRow[];
  /** Set only on an exact normalised match or a curated alias. */
  stockCode: string;
  companyName: string;
  matchMethod: string;
}

export interface DonationsCorpusRow {
  partyReturnCount: number;
  receiptCount: number;
  donationMadeCount: number;
  mpReturnCount: number;
  mpReturnResolvedCount: number;
  candidateReturnCount: number;
  candidateReturnResolvedCount: number;
  nilCandidateReturnCount: number;
  candidateDonationCount: number;
  firstFinancialYearEnd: number;
  lastFinancialYearEnd: number;
  // Payer/donor NAMES in the corpus that resolve to an ASX listing, and the
  // number of distinct listings they resolve to.
  matchedPayerNameCount: number;
  matchedPayerCodeCount: number;
  // How many company names the matcher can match AGAINST. A property of the
  // company metadata — an order of magnitude larger, and it describes no
  // donation. Publishable only as the denominator, never as a count of payers.
  matchableCompanyNameCount: number;
}

/** Every mandatory note, exactly as the API served it. Never paraphrased. */
export interface DonationsNotes {
  censoring: string;
  reform: string;
  coverage: string;
  verbatim: string;
  donorScope: string;
  attribution: string;
  licence: string;
}

export interface DonationsPage {
  /** The query the SERVER actually ran, after its own clamping. */
  query: DonationsQuery;
  /**
   * The year the RESPONSE reported, which is the one to caption.
   *
   * An empty request means "the latest year held" and the backend resolves it,
   * so the requested year and the year that produced these figures are not
   * always the same string. Captioning the request would put a blank — or last
   * year's label — over this year's numbers.
   */
  financialYear: string;
  years: FinancialYearRow[];
  parties: PartyFundingRow[];
  corpus?: DonationsCorpusRow;
  /** One page of payers, under `query.partyGroup`. */
  payers: PayerRow[];
  payerTotal: number;
  /** The FY the payer list was served for. */
  payerFinancialYear: string;
  /** Listed-company payers for the year, merged across the groups below. */
  listedPayers: PayerRow[];
  /** Which party groups the listed rail actually covers, named rather than implied. */
  listedGroups: string[];
  /**
   * Groups with listed payers this year that the rail does not cover — over the
   * WHOLE year, not over the page of groups the overview carried. Stated, never
   * hidden.
   */
  listedOmittedGroupCount: number;
  /**
   * FALSE when the API served no per-year population to subtract from. The count
   * above is then a floor observed from the page, and the surface says so
   * instead of publishing a confident zero it cannot support.
   */
  listedGroupCountKnown: boolean;
  /** Matched payers within those groups, of which the rail renders the largest. */
  listedTotal: number;
  notes: DonationsNotes;
  /** ISO 8601. The AEC snapshot these figures were read from. */
  asAt: string;
  /**
   * Did each request answer?
   *
   * REQUIRED, AND NOT INFERABLE FROM THE ROWS. An outage and a filter nobody
   * matches both arrive as zero rows and mean opposite things: wording the first
   * as the second publishes "no payer declared anything" over our own downtime.
   * `false` is a normal result — the action never throws.
   */
  overviewOk: boolean;
  payersOk: boolean;
  listedOk: boolean;
}

export interface DonationsExplorerProps {
  initialPage: DonationsPage;
  loadPage: (query: DonationsQuery) => Promise<DonationsPage>;
}

/* ----------------------------------------------------------------- styling */

const SELECT_CLASS =
  "h-8 rounded-md border border-input bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ring";

const FIELD_LABEL_CLASS = "text-[10px] uppercase tracking-wide text-muted-foreground";

const OUTAGE_CLASS = "rounded-md border border-dashed p-3 text-sm text-muted-foreground";

/* ------------------------------------------------------------------ pieces */

/**
 * The listed-company chip.
 *
 * Rendered ONLY on an exact normalised-name match or a curated alias — the API
 * never sets a code otherwise, and an absent code means "not matched", never
 * "not a listed company". The match method is on the chip's title so a reader
 * can see which of the two rules linked this payer.
 */
/**
 * WHICH OF THE TWO RULES LINKED A PAYER, in words.
 *
 * A title attribute is invisible to a touch reader and to a screen reader alike,
 * so the provenance of a link between a lodged name and a listed company was
 * effectively unpublished. The two rules are not equivalent — one is arithmetic
 * on a normalised string, the other is a human decision that is ours and not the
 * AEC's — and a reader deciding how much weight to put on a chip needs to know
 * which they are looking at.
 */
function matchMethodLabel(matchMethod: string): string {
  return matchMethod === "curated_alias"
    ? "matched by a human-verified alias"
    : "matched by exact name";
}

function ListedCompanyChip({ payer }: { payer: PayerRow }) {
  if (!payer.stockCode) return null;
  const provenance = matchMethodLabel(payer.matchMethod);
  return (
    <Link
      href={`/shorts/${payer.stockCode}`}
      title={
        payer.matchMethod === "curated_alias"
          ? "Linked to this ASX listing by a human-verified alias."
          : "Linked to this ASX listing by an exact normalised name match."
      }
      className="inline-flex items-center gap-1 rounded-sm border border-muted-foreground/30 px-1.5 py-0 text-[10px] hover:border-foreground/40"
    >
      <span className="font-medium">{payer.stockCode}</span>
      {payer.companyName ? (
        <span className="text-muted-foreground">{payer.companyName}</span>
      ) : null}
      {/* Visible, and part of the link's accessible name rather than a tooltip. */}
      <span className="text-muted-foreground">· {provenance}</span>
    </Link>
  );
}

/** Which party groups a payer's money went to, and how much to each. */
function RecipientList({ recipients }: { recipients: PayerRecipientRow[] }) {
  if (recipients.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-muted-foreground">
      {recipients.map((recipient) => (
        <li key={recipient.partyGroup} className="flex items-center gap-1">
          <span
            aria-hidden
            className="inline-block h-1.5 w-1.5 rounded-full"
            style={{ backgroundColor: partyGroupColor(recipient.partyGroup) }}
          />
          <span>{recipient.partyGroup}</span>
          <span className="tabular-nums">{formatCents(recipient.amountCents)}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ island */

export function DonationsExplorer({ initialPage, loadPage }: DonationsExplorerProps) {
  const [page, setPage] = useState<DonationsPage>(initialPage);
  /**
   * THE CONTROLS' OWN STATE, which is not the last response's echoed query.
   *
   * Building each request from `page.query` builds it from the last response, so
   * two changes in flight compose wrongly: change the year, then the party
   * before the first lands, and the second request carries the OLD year — and
   * when it lands, the year control snaps back to it, undoing the reader's
   * selection in front of them. Same lesson as the activity explorer.
   */
  const [pendingQuery, setPendingQuery] = useState<DonationsQuery>(initialPage.query);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  // Every request carries a sequence number and only the newest may write state:
  // two fast filter changes otherwise race and the SLOWER one wins, leaving the
  // page showing figures that match neither control.
  const sequence = useRef(0);
  const controlsId = useId();

  const run = useCallback(
    (next: DonationsQuery) => {
      const ticket = (sequence.current += 1);
      setPendingQuery(next);
      setStatus("loading");
      loadPage(next)
        .then((result) => {
          if (sequence.current !== ticket) return;
          setPage(result);
          // The backend's clamp wins over what was asked for: it is the only
          // description of the figures now on screen.
          setPendingQuery(result.query);
          setStatus("idle");
        })
        .catch(() => {
          if (sequence.current !== ticket) return;
          setStatus("error");
        });
    },
    [loadPage],
  );

  const setFilter = useCallback(
    // Any filter change resets to the first page: keeping the offset would land
    // a reader on page 4 of a 2-page result and show them nothing.
    (patch: Partial<DonationsQuery>) => run({ ...pendingQuery, ...patch, offset: 0 }),
    [pendingQuery, run],
  );

  /**
   * THE YEAR THE RESPONSE SERVED, never the year the control holds.
   *
   * An empty request means "the latest year held" and the server resolves it, so
   * on first load the control's value and the served year genuinely differ. Every
   * caption below reads from here.
   */
  const servedYear = page.financialYear;
  const partyFilter = page.query.partyGroup;
  const parties = page.parties;

  /**
   * The party-group options come from the RESPONSE'S OWN ROWS for the served
   * year, not from a palette or a constant: party groups come and go between
   * years, and a hand-built list would offer a filter that returns nothing and
   * looks like an absence.
   */
  const partyOptions = parties.map((party) => party.partyGroup);

  /**
   * A year control with no options is an unusable control. When the overview did
   * not answer there is no year list, so the served year (if any) stands alone
   * rather than leaving an empty select that looks like a corpus with no years.
   */
  const yearOptions =
    page.years.length > 0
      ? page.years
      : servedYear
        ? [{ financialYear: servedYear, partyGroupCount: parties.length, listedGroupCount: 0 }]
        : [];

  const barRows = useCallback(
    (value: (party: PartyFundingRow) => number, count: (party: PartyFundingRow) => string) =>
      parties
        .map(
          (party): FundingBarRow => ({
            label: party.partyGroup,
            color: partyGroupColor(party.partyGroup),
            valueCents: value(party),
            countLabel: count(party),
            postReformScheme: party.postReformScheme,
          }),
        )
        .filter((row) => row.valueCents > 0)
        .sort((a, b) => b.valueCents - a.valueCents),
    [parties],
  );

  /**
   * THE SUBSET SENTENCE FOR ONE CHART.
   *
   * A group with nothing lodged for a measure is filtered out of that measure's
   * chart — drawing a zero-length bar beside a party's name is not a reading a
   * bar chart supports. But a chart that silently drops rows the chart beside it
   * shows reads as "this party lodged nothing at all", so where filtering
   * happened the chart says so. Nothing is rendered when nothing was dropped.
   */
  const subsetNote = useCallback(
    (rows: FundingBarRow[]): string | undefined =>
      rows.length < parties.length
        ? "Only party groups with a non-zero figure for this measure appear here."
        : undefined,
    [parties.length],
  );

  /**
   * How many party groups the year holds, against how many these charts draw.
   *
   * The overview serves the LARGEST 25 groups and a year can hold seventy-odd,
   * so three charts with no statement of that read as the whole field. The
   * population is the response's own figure for the served year; when the year
   * row is missing there is nothing honest to say and the sentence is omitted.
   */
  const partyGroupPopulation =
    page.years.find((year) => year.financialYear === servedYear)?.partyGroupCount ?? 0;
  const partyGroupsShown = parties.length;

  // One row set per measure, built once: each is also the input to that chart's
  // own subset sentence, and building them twice would let the two disagree.
  const totalReceiptsRows = barRows(
    (party) => party.totalReceiptsCents,
    (party) => returnCountLabel(party.partyReturnCount),
  );
  const itemisedReceiptsRows = barRows(
    (party) => party.itemisedReceiptsCents,
    (party) => payerCountLabel(party.distinctPayerCount),
  );
  const declaredDonationsRows = barRows(
    (party) => party.declaredDonationsCents,
    (party) => donorCountLabel(party.distinctDonorCount),
  );

  const hasPrevious = page.query.offset > 0;
  const hasNext = page.query.offset + page.payers.length < page.payerTotal;

  /*
   * THE TWO EMPTY RESULTS, WHICH MEAN OPPOSITE THINGS.
   *
   * An OUTAGE is a thrown action or a response the server marked not-ok — the
   * request did not answer, whatever the row count says. An unfiltered empty
   * payer list is an outage too, by arithmetic: the corpus holds 124k itemised
   * receipts and every year in it has payers.
   *
   * Everything left over — zero rows, a party filter set, a response that
   * answered — is the one case where "no payer matched" is an honest sentence,
   * and it is about the FILTER, never about a party or a payer.
   */
  const overviewOutage = status === "error" || !page.overviewOk;
  const payerOutage =
    status === "error" || !page.payersOk || (page.payers.length === 0 && !partyFilter);

  return (
    <div className="space-y-10">
      <div className="flex flex-wrap items-end gap-2">
        {/*
          Native selects, not the Radix kit: this is a filter surface on a route
          with a bundle budget, and its filter BEHAVIOUR is what the tests drive —
          the repo's Radix select mock renders inert divs.
        */}
        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Financial year</span>
          <select
            id={`${controlsId}-year`}
            className={SELECT_CLASS}
            value={pendingQuery.financialYear || servedYear}
            onChange={(e) => setFilter({ financialYear: e.target.value })}
          >
            {yearOptions.map((year) => (
              <option key={year.financialYear} value={year.financialYear}>
                {year.financialYear}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className={FIELD_LABEL_CLASS}>Party group</span>
          <select
            id={`${controlsId}-party`}
            className={SELECT_CLASS}
            value={pendingQuery.partyGroup}
            onChange={(e) => setFilter({ partyGroup: e.target.value })}
          >
            <option value="">All party groups</option>
            {partyOptions.map((group) => (
              <option key={group} value={group}>
                {group}
              </option>
            ))}
          </select>
        </label>

        {pendingQuery.partyGroup ? (
          <button
            type="button"
            onClick={() => setFilter({ partyGroup: "" })}
            className="h-8 text-[11px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Clear party filter
          </button>
        ) : null}
      </div>

      <section aria-labelledby={`${controlsId}-measures`} className="space-y-4">
        <div className="space-y-1">
          <h2 id={`${controlsId}-measures`} className="text-sm font-medium">
            Party funding declared for {servedYear}
          </h2>
          {/*
            THE THREE MEASURES, AND WHY THEY ARE THREE CHARTS. Stated above the
            charts rather than beneath them: a note under three charts is read
            after the charts it governs, which is after the misreading.
          */}
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Three separate measures, lodged on three different forms by different people. They
            are shown side by side and never added together or stacked: a party&rsquo;s own
            return, the receipts its branches itemised, and the amounts donors declared giving
            it do not reconcile with one another.
          </p>
          {/*
            WHAT THESE CHARTS ARE A SLICE OF. The response carries the largest
            party groups, not every one in the year, and a chart that does not
            say so is read as the whole field.
          */}
          {partyGroupPopulation > partyGroupsShown ? (
            <p className="text-[11px] leading-relaxed tabular-nums text-muted-foreground">
              Each chart shows the {formatCount(partyGroupsShown)} largest of{" "}
              {formatCount(partyGroupPopulation)} party groups that lodged for {servedYear}, by
              the measure that chart names.
            </p>
          ) : null}
        </div>

        {overviewOutage ? (
          <p className={OUTAGE_CLASS} role="status">
            These figures are unavailable right now. Nothing here is missing from the AEC returns
            — this is our end.
          </p>
        ) : (
          <div
            aria-busy={status === "loading"}
            className={`grid gap-8 md:grid-cols-3 ${status === "loading" ? "opacity-60" : ""}`}
          >
            <FundingBars
              measureLabel="Total receipts, as the party declared them"
              measureNote="From each party group's own annual return."
              rows={totalReceiptsRows}
              subsetNote={subsetNote(totalReceiptsRows)}
            />
            <FundingBars
              measureLabel="Itemised receipts, declared by the recipient"
              measureNote="Transaction rows the party branches themselves itemised."
              rows={itemisedReceiptsRows}
              subsetNote={subsetNote(itemisedReceiptsRows)}
            />
            <FundingBars
              measureLabel="Donations, declared by the donor"
              measureNote="Transaction rows lodged on the other side of the ledger, by the giver."
              rows={declaredDonationsRows}
              subsetNote={subsetNote(declaredDonationsRows)}
            />
          </div>
        )}

        {/*
          The two notes that make every figure above readable, rendered from the
          strings the API served rather than restated here — so a wording fix
          lands in one place and every surface inherits it.
        */}
        <div className="space-y-1.5 rounded-md border border-muted-foreground/20 bg-muted/30 p-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">{page.notes.censoring}</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{page.notes.reform}</p>
        </div>
      </section>

      <section aria-labelledby={`${controlsId}-payers`} className="space-y-3">
        <div className="space-y-1">
          <h2 id={`${controlsId}-payers`} className="text-sm font-medium">
            Payers named in itemised receipts, {page.payerFinancialYear || servedYear}
            {partyFilter ? ` — ${partyFilter}` : ""}
          </h2>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {page.notes.donorScope}
          </p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {RECEIPT_SPLIT_NOTE} Names appear exactly as lodged; the source is not normalised, so
            one organisation can appear under more than one spelling.
          </p>
          {/*
            THE CENSORING NOTE TRAVELS WITH EVERY LIST OF FIGURES, not just with
            the charts at the top of the page. The rpc behind this table serves
            its own copy of it for exactly this reason: a payer list read without
            it looks like the whole of what a party received.
          */}
          {page.notes.censoring ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {page.notes.censoring}
            </p>
          ) : null}
        </div>

        {payerOutage ? (
          <p className={OUTAGE_CLASS} role="status">
            {partyFilter
              ? "This party group's payer list could not be loaded just now. Nothing here is missing from the AEC returns — this is our end."
              : "The payer list is unavailable right now. Nothing here is missing from the AEC returns — this is our end."}
          </p>
        ) : (
          <div aria-busy={status === "loading"} className={status === "loading" ? "opacity-60" : ""}>
            <ul className="divide-y">
              {page.payers.map((payer) => (
                <li key={payer.id} className="space-y-1 py-3">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="text-sm">{payer.donorName}</span>
                      <ListedCompanyChip payer={payer} />
                    </span>
                    <span className="shrink-0 text-sm tabular-nums">
                      {formatCents(payer.totalCents)}
                    </span>
                  </div>
                  <p className="text-[10px] tabular-nums text-muted-foreground">
                    {formatCount(payer.receiptCount)}{" "}
                    {payer.receiptCount === 1 ? "receipt" : "receipts"} recorded
                  </p>
                  <RecipientList recipients={payer.recipients} />
                  <ReceiptSplit split={payer.split} subject={payer.donorName} compact />
                </li>
              ))}
            </ul>

            {page.payers.length === 0 ? (
              // The ONLY empty state that says anything about a result rather
              // than about us: the request answered, a filter is set, nothing
              // matched it.
              <p className={OUTAGE_CLASS}>
                No payer is itemised under this party group in this year. That is what the filter
                returned, not a statement about the party.
              </p>
            ) : null}

            <div className="flex flex-wrap items-center justify-between gap-2 pt-3 text-[11px] text-muted-foreground">
              <span className="tabular-nums">
                {page.payers.length === 0
                  ? "0 payers"
                  : `${page.query.offset + 1}–${page.query.offset + page.payers.length} of ${formatCount(page.payerTotal)}`}
              </span>
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={!hasPrevious || status === "loading"}
                  onClick={() =>
                    // The FILTERS come from the controls, the OFFSET from the
                    // page on screen: paging moves from what the reader is
                    // looking at, under whatever they currently have selected.
                    run({
                      ...pendingQuery,
                      offset: Math.max(0, page.query.offset - page.query.limit),
                    })
                  }
                  className="rounded border px-2 py-1 disabled:opacity-40 enabled:hover:text-foreground"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={!hasNext || status === "loading"}
                  onClick={() =>
                    run({ ...pendingQuery, offset: page.query.offset + page.query.limit })
                  }
                  className="rounded border px-2 py-1 disabled:opacity-40 enabled:hover:text-foreground"
                >
                  Next
                </button>
              </span>
            </div>
          </div>
        )}
      </section>

      <section aria-labelledby={`${controlsId}-listed`} className="space-y-3">
        <div className="space-y-1">
          <h2 id={`${controlsId}-listed`} className="text-sm font-medium">
            ASX-listed payers, {page.payerFinancialYear || servedYear}
          </h2>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Payers whose lodged name matches an ASX listing exactly, or through a human-verified
            alias. A payer with no chip is not matched, which is not the same as not listed; a
            normalised name that collides across stock codes is left out entirely.
          </p>
          {/* The rail's own scope, named rather than implied. */}
          {page.listedGroups.length > 0 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Covering receipts declared by {page.listedGroups.join(", ")}.
              {page.listedOmittedGroupCount > 0 ? (
                <>
                  {" "}
                  <span className="tabular-nums">{page.listedOmittedGroupCount}</span> further
                  party {page.listedOmittedGroupCount === 1 ? "group" : "groups"} recorded a listed
                  payer this year and {page.listedOmittedGroupCount === 1 ? "is" : "are"} not
                  included here.
                </>
              ) : null}
              {/*
                THE POPULATION, OR A STATEMENT THAT WE DO NOT HAVE IT. The count
                above is a subtraction from how many party groups the whole year
                holds with a matched payer; without that figure the only honest
                thing to publish is the limitation, never a zero that reads as
                "these are all of them".
              */}
              {!page.listedGroupCountKnown ? (
                <>
                  {" "}
                  How many party groups recorded a matched payer across the whole of this year is
                  not available here, so groups beyond those named cannot be counted.
                </>
              ) : null}
            </p>
          ) : null}
          {/*
            The same censoring note the charts carry, served per rpc so it can
            travel with this rail too: a list of matched companies read without
            it looks like every listed company that paid a party this year.
          */}
          {page.notes.censoring ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {page.notes.censoring}
            </p>
          ) : null}
        </div>

        {/*
          `status === "error"` is an outage of the LAST REQUEST the reader made,
          which the flags on the page they are still looking at cannot describe:
          without it this rail renders the previous year's rows beside two panels
          saying the request failed.
        */}
        {status === "error" || !page.listedOk ? (
          <p className={OUTAGE_CLASS} role="status">
            The listed-company list is unavailable right now — this is our end.
          </p>
        ) : page.listedPayers.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No payer in this year matched an ASX listing under these rules.
          </p>
        ) : (
          <>
            {page.listedTotal > page.listedPayers.length ? (
              <p className="text-[11px] tabular-nums text-muted-foreground">
                Showing the {formatCount(page.listedPayers.length)} largest of{" "}
                {formatCount(page.listedTotal)} matched payers, by the amount recorded.
              </p>
            ) : null}
            <ul className="grid gap-3 sm:grid-cols-2">
            {page.listedPayers.map((payer) => (
              <li key={payer.id} className="space-y-1 rounded-lg border bg-card p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Link
                    href={`/shorts/${payer.stockCode}`}
                    className="min-w-0 text-sm hover:underline"
                  >
                    <span className="font-medium">{payer.stockCode}</span>
                    {payer.companyName ? (
                      <span className="text-muted-foreground"> · {payer.companyName}</span>
                    ) : null}
                  </Link>
                  <span className="shrink-0 text-sm tabular-nums">
                    {formatCents(payer.totalCents)}
                  </span>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Lodged as &ldquo;{payer.donorName}&rdquo; · {matchMethodLabel(payer.matchMethod)}
                </p>
                <RecipientList recipients={payer.recipients} />
                <ReceiptSplit split={payer.split} subject={payer.donorName} compact />
              </li>
            ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
