/**
 * The profile's "Funding returns" section renders amounts under a named
 * parliamentarian's photograph, which is the highest-risk placement in the whole
 * influence layer. What this file pins:
 *
 *   - PARTY MONEY NEVER APPEARS HERE. Money declared as given to a party is not
 *     money given to a member. The rpc behind the section does not serve a party
 *     figure, and the component must be incapable of rendering one — the
 *     assertion is on the rendered output, not just on the props.
 *   - SILENCE IS THE EMPTY STATE. A member with no linked return renders
 *     nothing: no heading, no frame, no "no returns" line. Most parliamentarians
 *     never lodge an annual return, so an empty frame would read as "received
 *     nothing".
 *   - THE COVERAGE SENTENCE IS ALWAYS THERE, from the response. This layer holds
 *     52 annual returns in total and no senator's is linked to a member page, so
 *     a section that does not state its coverage lies by construction.
 *   - ELECTION RETURNS ARE LINKED RETURNS, NOT A TIMELINE. Linking is per return
 *     and conservative, so an election that is not listed says nothing about
 *     whether one was lodged — and the section must never render an unlinked
 *     event as an absence.
 *   - A NIL RETURN IS A FACT. "Lodged a return declaring no gifts" is what the
 *     return says, and it is rendered as that rather than as missing data.
 *   - AN EMPTY DONOR LIST IS NOT "NO DONORS". Most returns state a total without
 *     naming the givers, so the event's own coverage travels with the row.
 */

import { render, screen } from "@testing-library/react";

import {
  FundingReturns,
  type CandidateElectionReturnInput,
  type MemberAnnualReturnInput,
} from "../profile/funding-returns";

const COVERAGE = "SERVED COVERAGE NOTE, including senators not being linked here.";
const ATTRIBUTION = "SERVED ATTRIBUTION NOTE: party money is not attributable to a member.";
const CENSORING = "SERVED CENSORING NOTE.";

function annual(overrides: Partial<MemberAnnualReturnInput> = {}): MemberAnnualReturnInput {
  return {
    financialYear: "2023-24",
    financialYearEnd: 2024,
    returnType: "Member of House of Representatives Return",
    chamber: "house",
    memberName: "HAINES, Dr Helen",
    totalDonationsCents: 123_456_00,
    donorCount: 7,
    sourceUrl: "https://transparency.aec.gov.au/AnnualMemberOfParliament/1",
    ...overrides,
  };
}

function candidate(
  overrides: Partial<CandidateElectionReturnInput> = {},
): CandidateElectionReturnInput {
  return {
    event: "2025 Federal Election",
    eventYear: 2025,
    returnType: "Candidate",
    candidateName: "HAINES, Helen",
    partyName: "Independent",
    electorateName: "Indi",
    electorateState: "VIC",
    nilReturn: false,
    amendmentNo: 0,
    totalGiftCents: 500_000_00,
    donorCount: 3,
    expenditureCents: 400_000_00,
    discretionaryCents: 0,
    donations: [],
    eventReturnCount: 1461,
    eventItemisedReturnCount: 69,
    sourceUrl: "https://transparency.aec.gov.au/ElectionCandidate/1",
    ...overrides,
  };
}

function renderSection(props: Partial<React.ComponentProps<typeof FundingReturns>> = {}) {
  return render(
    <FundingReturns
      annualReturns={[annual()]}
      candidateReturns={[candidate()]}
      coverageNote={COVERAGE}
      attributionNote={ATTRIBUTION}
      censoringNote={CENSORING}
      {...props}
    />,
  );
}

describe("profile funding returns", () => {
  it("renders nothing at all when no return names the member", () => {
    const { container } = render(
      <FundingReturns
        annualReturns={[]}
        candidateReturns={[]}
        coverageNote={COVERAGE}
        attributionNote={ATTRIBUTION}
      />,
    );

    // Not an empty frame, not a "no returns" line. An absence claim about a
    // named person is exactly what the register cannot support.
    expect(container).toBeEmptyDOMElement();
  });

  it("states the attribution rule before any figure", () => {
    renderSection();
    expect(screen.getByText(ATTRIBUTION)).toBeInTheDocument();
  });

  it("always renders the coverage sentence the response served", () => {
    renderSection();
    expect(screen.getByText(COVERAGE)).toBeInTheDocument();
    expect(screen.getByText(CENSORING)).toBeInTheDocument();
  });

  it("renders the coverage sentence even for a member with only a nil return", () => {
    renderSection({
      annualReturns: [],
      candidateReturns: [candidate({ nilReturn: true, totalGiftCents: 0, donorCount: 0 })],
    });
    expect(screen.getByText(COVERAGE)).toBeInTheDocument();
  });

  it("renders annual-return totals by financial year, in dollars", () => {
    renderSection();
    expect(screen.getByText("2023-24")).toBeInTheDocument();
    expect(screen.getByText("$123,456")).toBeInTheDocument();
    expect(screen.getByText(/7 donors/)).toBeInTheDocument();
    // The name is verbatim as lodged, honorifics intact.
    expect(screen.getByText(/HAINES, Dr Helen/)).toBeInTheDocument();
  });

  it("words a zero annual return as a declaration, never as a measured $0", () => {
    // 16 of the 52 annual returns in the corpus declare nothing. "$0" beside a
    // named member reads as a measurement; the return's own statement is that
    // it received no donations.
    renderSection({
      annualReturns: [annual({ totalDonationsCents: 0, donorCount: 0 })],
      candidateReturns: [],
    });

    expect(screen.getByText("Lodged a return declaring no donations")).toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  });

  it("says how many of a return's declared donors it actually names", () => {
    // The threshold rules mean only gifts above the year's limit are itemised.
    // Fourteen names under a return declaring a thousand donors, with nothing
    // said, invites a reader to take the fourteen for the list.
    renderSection({
      candidateReturns: [
        candidate({
          donorCount: 1006,
          donations: [
            { donorName: "A Fund Pty Ltd", dateLabel: "17 Apr 2025", amountCents: 30_000_00 },
          ],
        }),
      ],
    });

    expect(
      screen.getByText(/declares 1,006 donors and names 1 of them individually/),
    ).toBeInTheDocument();
  });

  it("renders a nil return as the fact it is", () => {
    renderSection({
      candidateReturns: [candidate({ nilReturn: true, totalGiftCents: 0, donorCount: 0 })],
    });

    expect(screen.getByText("Lodged a return declaring no gifts")).toBeInTheDocument();
    // And not as an amount of nothing, which reads as a measurement.
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
  });

  it("words a zero-gift return as a declaration even without the nil flag", () => {
    // The annual branch's own doctrine, applied to candidate returns: "$0 · 0
    // donors" beside a named candidate reads as a measurement, and a return
    // declaring nothing makes the same statement whether or not the source set
    // the flag on it.
    renderSection({
      annualReturns: [],
      candidateReturns: [candidate({ nilReturn: false, totalGiftCents: 0, donorCount: 0 })],
    });

    expect(screen.getByText("Lodged a return declaring no gifts")).toBeInTheDocument();
    expect(screen.queryByText("$0")).not.toBeInTheDocument();
    expect(screen.queryByText(/0 donors/)).not.toBeInTheDocument();
  });

  it("prints the name each return was lodged under, verbatim", () => {
    // Candidate returns are linked by matching a lodged name, and a namesake has
    // landed on the wrong member's page before. The name on the return is what
    // makes any future misattribution visible to the reader.
    renderSection({
      candidateReturns: [candidate({ candidateName: "HAINES, Helen" })],
    });

    expect(screen.getByText(/Lodged as “HAINES, Helen”/)).toBeInTheDocument();
  });

  it("presents election returns as linked returns, with no gap and no year axis", () => {
    renderSection({
      // One linked return only. The member stood at other elections; those are
      // simply not here, and the section must not say anything about them.
      candidateReturns: [candidate()],
    });

    expect(screen.getByText("Election returns linked to this member")).toBeInTheDocument();
    expect(screen.getByText(/has not been shown to lack one/i)).toBeInTheDocument();
    expect(screen.queryByText(/no return/i)).not.toBeInTheDocument();
    // Exactly one event rendered — no placeholder rows for unlinked elections.
    expect(screen.getAllByText(/Federal Election/)).toHaveLength(1);
  });

  it("carries the event's own coverage when a return names no donors", () => {
    renderSection({ candidateReturns: [candidate({ donations: [] })] });

    // An empty donation list is NOT "no donors" — most returns state a total
    // without naming the givers, and the corpus-wide figure says so.
    expect(
      screen.getByText(/does not name its donors individually/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1,461 returns lodged for this event, 69 name their donors/)).toBeInTheDocument();
  });

  it("itemises donors where the return names them", () => {
    renderSection({
      candidateReturns: [
        candidate({
          donations: [
            { donorName: "Climate 200 Pty Ltd", dateLabel: "17 Apr 2025", amountCents: 250_000_00 },
            { donorName: "A Private Donor", dateLabel: "", amountCents: 10_000_00 },
          ],
        }),
      ],
    });

    expect(screen.getByText("Climate 200 Pty Ltd")).toBeInTheDocument();
    expect(screen.getByText("$250,000")).toBeInTheDocument();
    // A return that omits a date says so rather than being given one.
    expect(screen.getByText("date not stated")).toBeInTheDocument();
    // And the coverage line does not appear beside an itemised return.
    expect(screen.queryByText(/does not name its donors individually/)).not.toBeInTheDocument();
  });

  it("publishes the amendment number so a revised figure reads as a revision", () => {
    renderSection({ candidateReturns: [candidate({ amendmentNo: 2 })] });
    expect(screen.getByText(/Amendment 2/)).toBeInTheDocument();
  });

  it("renders no party-level figure anywhere in its output", () => {
    const { container } = renderSection();
    const text = container.textContent ?? "";

    // The three party measures, by their own words. None of them can reach this
    // section: the rpc does not serve them and the component does not accept
    // them, and this asserts the RENDERED result rather than the props.
    for (const phrase of [
      "Total receipts",
      "Itemised receipts",
      "party group",
      "Party group",
      "declared donations",
    ]) {
      expect(text).not.toContain(phrase);
    }
  });

  it("links each return to the AEC document it came from", () => {
    renderSection();
    const links = screen.getAllByRole("link", { name: /AEC return/ });
    expect(links.length).toBeGreaterThanOrEqual(2);
    expect(links[0]).toHaveAttribute("target", "_blank");
    expect(links[0]).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });
});
