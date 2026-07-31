/**
 * The operator console's editorial invariants, pinned.
 *
 * This screen is where a human decision becomes a curated alias, and a curated
 * alias is the ONE match method the public gate lets publish a live company link
 * against a named politician. So the things that must be true of the UI are not
 * cosmetic:
 *
 *   1. the blast radius is on screen BEFORE the decision, counted in PEOPLE
 *   2. the real declarations are on screen, each with its own source link
 *   3. there is NO fuzzy / probable / maybe affordance anywhere in the DOM
 *   4. the stopword trap is named inline, not left to the reviewer to remember
 *   5. the gate is never rendered as a bare percentage
 *
 * (3) is the one worth having a test for even though it sounds obvious: the
 * public gate CHECK forbids match_method='analyst_fuzzy' from ever being
 * published, so an "I think it's probably X" button would produce a decision the
 * database refuses AFTER the reviewer has already made a call about a named
 * individual.
 */

import { render, screen, within } from "@testing-library/react";

import { SecuritiesReview } from "../securities-review";
import type { Coverage, QueueItem, QueuePage } from "~/app/actions/admin/registerReview";

jest.mock("~/app/actions/admin/registerReview", () => ({
  __esModule: true,
  listSecurityQueue: jest.fn().mockResolvedValue({ items: [], totalCandidates: 0, totalRows: 0 }),
  searchListings: jest.fn().mockResolvedValue([]),
  decideSecurityCandidate: jest.fn(),
  undoSecurityDecision: jest.fn(),
}));

// A real candidate from the loaded corpus: six rows across FIVE members, which
// is exactly the case the blast-radius rule exists for.
const SYDNEY_AIRPORT: QueueItem = {
  candidateNorm: "SYDNEY AIRPORT",
  example: "Sydney Airport",
  occurrences: 6,
  people: 5,
  items: [1],
  parliaments: [45, 46],
  entityKinds: ["listed"],
  gateRows: 6,
  skipCount: 0,
  samples: [
    {
      declaredText: "Sydney Airport",
      politicianName: "A Member",
      politicianSlug: "a-member",
      itemNo: 1,
      parliament: 45,
      sourceUrl: "https://www.aph.gov.au/example.pdf",
    },
  ],
  proposal: null,
};

const COVERAGE: Coverage = {
  resolved: 1174,
  listedCandidates: 2294,
  gatePercent: 51.17698,
  backlogCandidates: 2070,
  backlogRows: 2638,
  classifiedOut: 15,
  method:
    "resolved / entity_kind='listed' item-1 candidates. The denominator is a DEFAULT bucket.",
};

function renderConsole(item: QueueItem = SYDNEY_AIRPORT) {
  const page: QueuePage = { items: [item], totalCandidates: 2070, totalRows: 2638 };
  return render(<SecuritiesReview initialPage={page} initialCoverage={COVERAGE} />);
}

describe("securities review console", () => {
  it("states the blast radius in named people before any decision", () => {
    renderConsole();
    // Not "6 rows" alone: a wrong alias is one wrong fact per PERSON.
    expect(screen.getByText("5 members")).toBeInTheDocument();
    expect(screen.getByText("6 rows")).toBeInTheDocument();
  });

  it("shows the actual declaration and links its own source document", () => {
    renderConsole();
    // The candidate heading and the sample both read "Sydney Airport" — that is
    // the point, the reviewer compares the normalised token against what was
    // actually written — so assert on the sample list specifically.
    const samples = screen.getByText("Declared as").closest("div") as HTMLElement;
    expect(within(samples).getByText("Sydney Airport")).toBeInTheDocument();
    const source = screen.getByRole("link", { name: /source/i });
    expect(source).toHaveAttribute("href", "https://www.aph.gov.au/example.pdf");
    // The citation points at aph.gov.au, never at a copy of ours (§7.3: no
    // affordance that puts the source document on the operator's disk).
    expect(source.getAttribute("href")).toMatch(/^https:\/\/www\.aph\.gov\.au\//);
  });

  it("offers NO fuzzy, probable or maybe affordance anywhere in the DOM", () => {
    const { container } = renderConsole();
    // The public gate forbids analyst_fuzzy from ever being 'resolved'. If the
    // UI can express it, a reviewer learns that from a CHECK violation after
    // deciding about a named person.
    //
    // Asserted over INTERACTIVE ELEMENTS, not all text: the legend explains in
    // prose that there is no "probably" key, and a rule that forbade saying so
    // would delete the sentence that teaches the reviewer why.
    const controls = container.querySelectorAll("button, input, select, [role='button']");
    for (const el of Array.from(controls)) {
      const label = `${el.textContent ?? ""} ${el.getAttribute("placeholder") ?? ""} ${
        el.getAttribute("aria-label") ?? ""
      }`;
      expect(label).not.toMatch(/fuzzy|probabl|maybe|best guess|looks like/i);
    }
    for (const name of [/fuzzy/i, /probable/i, /maybe/i]) {
      expect(screen.queryByRole("button", { name })).toBeNull();
    }
  });

  it("offers exactly the closed decision vocabulary", () => {
    renderConsole();
    for (const label of [
      /Resolve/,
      /Unlisted fund/,
      /Not a security/,
      /Skip/,
      /Foreign listing/,
    ]) {
      expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
    }
  });

  it("renders the gate with its method, never as a bare percentage", () => {
    renderConsole();
    expect(screen.getByText("51.18%")).toBeInTheDocument();
    // The method travels with the number: §8.19.1 records that this figure moves
    // 30.66% -> 49.89% -> ~80% with the NUMERATOR FROZEN, so a bare percentage
    // is a claim the data does not support.
    expect(screen.getByText(/DEFAULT bucket/i)).toBeInTheDocument();
    // Both halves are separately visible so a reviewer can see WHICH one moved.
    expect(screen.getByText("Classified out")).toBeInTheDocument();
    expect(screen.getByText("Resolved")).toBeInTheDocument();
  });

  it("says plainly when a candidate cannot move the gate", () => {
    renderConsole({ ...SYDNEY_AIRPORT, gateRows: 0 });
    expect(screen.getByText(/outside the item-1 gate/i)).toBeInTheDocument();
  });

  it("shows a model proposal as evidence, never as a decision", () => {
    renderConsole({
      ...SYDNEY_AIRPORT,
      proposal: {
        proposedStockCode: "SYD",
        proposedCompanyName: "Sydney Airport",
        confidence: 0.9,
        rationale: "the declared name matches the listing",
        model: "gemini-3.1-flash-lite",
        status: "proposed",
        shortlist: [
          { stockCode: "SYD", companyName: "Sydney Airport", existingUses: 3, isStopwordTicker: false },
        ],
      },
    });
    expect(screen.getByText(/Model suggests SYD/)).toBeInTheDocument();
    // It once proposed FLIGHTS -> Flight Centre, which is a gift-log entry.
    expect(screen.getByText(/cannot publish anything on its own/i)).toBeInTheDocument();
  });

  it("uses no warning or currency iconography beside a named person", () => {
    const { container } = renderConsole();
    // Editorial rule 2: an icon that reads as a flag next to a person is an
    // accusation. Rule 5: no glyph may imply value.
    expect(container.textContent ?? "").not.toMatch(/[⚠🚨🔴🚩👀💰💵🪙💲]/u);
  });

  it("never renders a currency amount", () => {
    const { container } = renderConsole();
    // The registers record what is held, never how much. There is no amount
    // column in the schema and there must be no amount on the screen.
    expect(container.textContent ?? "").not.toMatch(/\$\s*\d/);
  });

  it("keeps the decision keys discoverable rather than hidden", () => {
    renderConsole();
    const legend = screen.getByText("Keys").closest("div");
    expect(legend).not.toBeNull();
    expect(within(legend as HTMLElement).getByText(/no .probably. key/i)).toBeInTheDocument();
  });
});
