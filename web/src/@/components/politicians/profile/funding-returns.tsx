/**
 * The profile section "Funding returns lodged with the AEC".
 *
 * WHAT THIS SECTION MAY CONTAIN, AND WHAT IT MAY NEVER. Only returns that NAME
 * this member: their own annual member return, and the election returns they
 * lodged as a candidate. Party-level money — a party group's receipts, its
 * itemised payers, its declared donations — never appears here and cannot: the
 * rpc behind this section does not serve it, and a test asserts no party-group
 * total reaches this file. Money declared as given to a party is not money given
 * to a member, and rendering it under a named person's photograph is the exact
 * imputation the editorial standards exist to prevent.
 *
 * ELECTION RETURNS ARE LINKED RETURNS, NEVER A LODGEMENT TIMELINE. Candidate
 * resolution is per-return and deliberately conservative: pre-2013 events resolve
 * to nobody at all, and a return does not link when the member did not hold that
 * division in the resulting parliament. So an election missing from this list
 * means "we did not link a return to this member for that event" — which is a
 * fact about our linking, not about their lodging. The list therefore shows only
 * what is linked, never a year axis, never a gap, never a "no return" row, and
 * the coverage note sits next to it saying so.
 *
 * A NIL RETURN IS A FACT, NOT MISSING DATA. "Lodged a return declaring no gifts"
 * is exactly what a nil return says, and it is rendered plainly as that. It is
 * not an empty state and it is not an absence.
 *
 * SILENCE IS THE EMPTY STATE. A member with no linked return renders nothing at
 * all — no heading, no frame, no "no returns" line. Most parliamentarians never
 * lodge an annual return, so an empty frame under this heading would read as
 * "received nothing", which the corpus cannot support.
 *
 * WHY AMOUNTS ARE HERE AT ALL, on a page whose every other figure is a count:
 * these are AEC figures, published under CC BY 4.0, from returns whose whole
 * purpose is to state amounts. The register of interests above them records what
 * is held and never how much — a different source, a different rule.
 */

import { formatCents, formatCount } from "@/lib/politics/funding-money";
import { sectionTitle } from "@/lib/typography";

/** One lodged annual member/senator return, as the rpc serves it. */
export interface MemberAnnualReturnInput {
  financialYear: string;
  financialYearEnd: number;
  /** Verbatim, e.g. 'Member of House of Representatives Return'. */
  returnType: string;
  chamber: string;
  /** Verbatim as lodged, honorifics intact. Never tidied. */
  memberName: string;
  totalDonationsCents: number;
  donorCount: number;
  sourceUrl: string;
}

export interface CandidateDonationInput {
  /** Verbatim as lodged. */
  donorName: string;
  /** Already formatted, or "" when the return omits the date. */
  dateLabel: string;
  amountCents: number;
}

export interface CandidateElectionReturnInput {
  /** Verbatim, e.g. '2025 Federal Election'. */
  event: string;
  eventYear: number;
  returnType: string;
  candidateName: string;
  partyName: string;
  electorateName: string;
  electorateState: string;
  nilReturn: boolean;
  amendmentNo: number;
  totalGiftCents: number;
  donorCount: number;
  expenditureCents: number;
  discretionaryCents: number;
  donations: CandidateDonationInput[];
  /** Corpus-wide, for this event: how many returns name their donors. */
  eventReturnCount: number;
  eventItemisedReturnCount: number;
  sourceUrl: string;
}

export interface FundingReturnsProps {
  annualReturns: MemberAnnualReturnInput[];
  candidateReturns: CandidateElectionReturnInput[];
  /** Served with the data, always. Rendered verbatim, never paraphrased. */
  coverageNote?: string;
  attributionNote?: string;
  censoringNote?: string;
}

const NOTE_CLASS = "text-[11px] leading-relaxed text-muted-foreground";

function SourceReturnLink({ sourceUrl }: { sourceUrl: string }) {
  if (!sourceUrl) return null;
  return (
    <a
      href={sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      title="Open this return on the AEC Transparency Register"
      className="whitespace-nowrap text-[10px] text-muted-foreground underline decoration-dotted hover:text-foreground"
    >
      AEC return&nbsp;↗
    </a>
  );
}

/**
 * Where a candidate stood, from the return's own fields.
 *
 * Assembled rather than asserted: a return that records no electorate simply
 * renders the party, and one that records neither renders nothing. Nothing is
 * filled in from the member's current seat — the return belongs to the election
 * it was lodged for, and seats change.
 */
function candidateContext(row: CandidateElectionReturnInput): string {
  const seat = [row.electorateName, row.electorateState].filter(Boolean).join(", ");
  return [seat, row.partyName].filter(Boolean).join(" · ");
}

export function FundingReturns({
  annualReturns,
  candidateReturns,
  coverageNote,
  attributionNote,
  censoringNote,
}: FundingReturnsProps) {
  // Silence, not an empty frame. See the file header.
  if (annualReturns.length === 0 && candidateReturns.length === 0) return null;

  // Newest first within each list. The candidate list is ORDERED, not indexed by
  // year: it is a list of linked returns, and a year axis would turn the gaps
  // between them into a claim.
  const annual = [...annualReturns].sort(
    (a, b) => b.financialYearEnd - a.financialYearEnd || b.financialYear.localeCompare(a.financialYear),
  );
  const candidates = [...candidateReturns].sort(
    (a, b) => b.eventYear - a.eventYear || a.event.localeCompare(b.event),
  );

  return (
    <section className="space-y-4 rounded-lg border bg-card p-4" aria-labelledby="funding-returns">
      <h2 id="funding-returns" className={sectionTitle}>
        Funding returns lodged with the AEC
      </h2>
      {/*
        THE ATTRIBUTION RULE FIRST, before any figure. The served note says that
        only returns naming this member appear and that party money is not
        attributable to an individual — which is the sentence that stops every
        figure below being read as "what their party received".
      */}
      {attributionNote ? <p className={NOTE_CLASS}>{attributionNote}</p> : null}

      {annual.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">
            Annual returns lodged by this member
          </h3>
          <ul className="divide-y">
            {annual.map((row) => (
              <li
                key={`${row.financialYear}-${row.returnType}`}
                className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
              >
                <span className="min-w-0">
                  <span className="text-sm tabular-nums">{row.financialYear}</span>{" "}
                  <span className="text-[11px] text-muted-foreground">{row.returnType}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    Lodged as &ldquo;{row.memberName}&rdquo;
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-2">
                  {/*
                    A ZERO RETURN IS A DECLARATION, NOT A MEASUREMENT — 16 of the
                    52 annual returns in the corpus declare nothing. Rendering
                    "$0" for one puts a measured-looking amount beside a named
                    member where the return's own statement is "I received no
                    donations", which is the same fact the candidate nil returns
                    below state in words. So it is worded, not formatted.
                  */}
                  {row.totalDonationsCents === 0 && row.donorCount === 0 ? (
                    <span className="text-[11px] text-muted-foreground">
                      Lodged a return declaring no donations
                    </span>
                  ) : (
                    <>
                      <span className="text-sm tabular-nums">
                        {formatCents(row.totalDonationsCents)}
                      </span>
                      <span className="text-[10px] tabular-nums text-muted-foreground">
                        {formatCount(row.donorCount)}{" "}
                        {row.donorCount === 1 ? "donor" : "donors"}
                      </span>
                    </>
                  )}
                  <SourceReturnLink sourceUrl={row.sourceUrl} />
                </span>
              </li>
            ))}
          </ul>
          <p className={NOTE_CLASS}>
            The total each return declares receiving in that financial year, and the number of
            donors it names.
          </p>
        </div>
      ) : null}

      {candidates.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-medium text-foreground">
            Election returns linked to this member
          </h3>
          {/*
            THE SENTENCE THAT MAKES THE LIST READABLE, and it sits ABOVE the
            list, not below it. Candidate returns are linked one at a time and
            conservatively; an election that is not listed has not been shown to
            lack a return. There is no year axis here for the same reason.
          */}
          <p className={NOTE_CLASS}>
            Returns this member is linked to, newest first. Linking is per return and exact — an
            election that does not appear here has not been shown to lack one.
          </p>
          <ul className="space-y-3">
            {candidates.map((row) => {
              const context = candidateContext(row);
              return (
                <li key={`${row.event}-${row.returnType}-${row.candidateName}`} className="space-y-1">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    <span className="min-w-0">
                      <span className="text-sm">{row.event}</span>
                      {row.returnType ? (
                        <span className="ml-2 text-[10px] text-muted-foreground">
                          {row.returnType}
                        </span>
                      ) : null}
                      {context ? (
                        <span className="block text-[10px] text-muted-foreground">{context}</span>
                      ) : null}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      {row.nilReturn ? (
                        // A FACT, stated as one. Not an empty state.
                        <span className="text-[11px] text-muted-foreground">
                          Lodged a return declaring no gifts
                        </span>
                      ) : (
                        <>
                          <span className="text-sm tabular-nums">
                            {formatCents(row.totalGiftCents)}
                          </span>
                          <span className="text-[10px] tabular-nums text-muted-foreground">
                            {formatCount(row.donorCount)}{" "}
                            {row.donorCount === 1 ? "donor" : "donors"}
                          </span>
                        </>
                      )}
                      <SourceReturnLink sourceUrl={row.sourceUrl} />
                    </span>
                  </div>

                  {row.amendmentNo > 0 ? (
                    // Published so a changed figure reads as a revision rather
                    // than as an inconsistency. The AEC amends returns
                    // continuously.
                    <p className="text-[10px] tabular-nums text-muted-foreground">
                      Amendment {row.amendmentNo} — the AEC publishes amended returns as they are
                      lodged.
                    </p>
                  ) : null}

                  {/*
                    THE ITEMISED ROWS ARE NOT THE DONORS. Helen Haines' 2025
                    return declares 1,006 donors and itemises 14 of them: the
                    threshold rules mean only gifts above the year's limit are
                    named, and the rest are a total. Rendering fourteen names
                    under a return declaring a thousand donors, with nothing
                    said, invites a reader to take the fourteen for the list.
                  */}
                  {row.donations.length > 0 && row.donorCount > row.donations.length ? (
                    <p className="ml-3 text-[10px] leading-relaxed tabular-nums text-muted-foreground">
                      This return declares {formatCount(row.donorCount)} donors and names{" "}
                      {formatCount(row.donations.length)} of them individually — gifts below the
                      year&rsquo;s disclosure threshold are not named in the return.
                    </p>
                  ) : null}

                  {row.donations.length > 0 ? (
                    <ul className="ml-3 space-y-0.5 border-l pl-3">
                      {row.donations.map((donation, index) => (
                        <li
                          key={`${donation.donorName}-${donation.dateLabel}-${index}`}
                          className="flex flex-wrap items-baseline justify-between gap-2 text-[11px]"
                        >
                          <span className="min-w-0">
                            {donation.donorName}
                            {donation.dateLabel ? (
                              <span className="ml-2 tabular-nums text-muted-foreground">
                                {donation.dateLabel}
                              </span>
                            ) : (
                              <span className="ml-2 text-muted-foreground">
                                date not stated
                              </span>
                            )}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {formatCents(donation.amountCents)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : !row.nilReturn && row.eventReturnCount > 0 ? (
                    /*
                      AN EMPTY DONATION LIST IS NOT "NO DONORS". Most returns
                      lodged for an election declare a total without naming the
                      givers, so the corpus-wide coverage for THIS event travels
                      with the row it caveats — otherwise the silence reads as a
                      claim.
                    */
                    <p className="text-[10px] leading-relaxed tabular-nums text-muted-foreground">
                      This return does not name its donors individually. Of{" "}
                      {formatCount(row.eventReturnCount)} returns lodged for this event,{" "}
                      {formatCount(row.eventItemisedReturnCount)} name their donors.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {/*
        ALWAYS RENDERED, whatever is above it. This layer is thin — 52 annual
        returns exist across the whole corpus, senators' are not yet linked to
        member pages at all — and a funding section that does not state its
        coverage lies by construction.
      */}
      {coverageNote ? <p className={NOTE_CLASS}>{coverageNote}</p> : null}
      {censoringNote ? <p className={NOTE_CLASS}>{censoringNote}</p> : null}
      <p className={NOTE_CLASS}>
        Source: AEC Transparency Register, reused under CC BY 4.0. &copy; Commonwealth of
        Australia. The AEC does not endorse this site or its analysis.
      </p>
    </section>
  );
}
