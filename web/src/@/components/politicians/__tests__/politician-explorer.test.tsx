/**
 * The explorer renders search results about named parliamentarians, so the
 * editorial rules apply to it exactly as they do to a profile page.
 *
 * The one that is easy to get wrong and invisible afterwards is the EMPTY
 * PROFILE: for the 44th and 45th parliaments we have not read every document, so
 * "no declared interests" is OUR COVERAGE GAP, not a finding about the person.
 * Rendering it as a bare "0" would state an absence about a named individual
 * that the data does not support.
 */

import { render, screen, waitFor } from "@testing-library/react";

import { PoliticianExplorer } from "../politician-explorer";
import type { PoliticianHit } from "@/lib/politics/politician-search";

jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const searchPoliticians = jest.fn();
jest.mock("@/lib/politics/politician-search", () => {
  const actual = jest.requireActual("@/lib/politics/politician-search");
  return {
    ...actual,
    searchPoliticians: (...args: unknown[]) => searchPoliticians(...args),
  };
});

const WITH_INTERESTS: PoliticianHit = {
  objectID: "a-member",
  slug: "a-member",
  display_name: "A Member",
  chamber: "house",
  division: "Example",
  state_code: "NSW",
  party_ab: "ALP",
  declared_listed_count: 3,
  declared_property_count: 1,
  has_interests: true,
  first_parliament: 46,
  last_parliament: 48,
  _highlightResult: {
    // Algolia's markers. Rendered as REACT NODES — this string is free text out
    // of a PDF and must never reach dangerouslySetInnerHTML.
    display_name: { value: "A <em>Member</em>", matchLevel: "partial" },
  },
};

const NO_INTERESTS: PoliticianHit = {
  objectID: "b-member",
  slug: "b-member",
  display_name: "B Member",
  chamber: "senate",
  state_code: "VIC",
  party_ab: "",
  declared_listed_count: 0,
  declared_property_count: 0,
  has_interests: false,
};

function mockResults(hits: PoliticianHit[]) {
  searchPoliticians.mockResolvedValue({
    hits,
    nbHits: hits.length,
    page: 0,
    nbPages: 1,
    hitsPerPage: 24,
    processingTimeMS: 2,
    query: "",
    facets: {
      party_ab: { ALP: 35, "": 54 },
      chamber: { house: 200, senate: 76 },
    },
  });
}

describe("politician explorer", () => {
  beforeEach(() => {
    searchPoliticians.mockReset();
  });

  it("states an empty profile as coverage, never as a finding", async () => {
    mockResults([NO_INTERESTS]);
    render(<PoliticianExplorer />);
    await waitFor(() =>
      expect(screen.getByText(/nothing matched yet in the documents read/i)).toBeInTheDocument(),
    );
    // Not "0 declared companies", and not "declared nothing".
    expect(screen.queryByText(/declared nothing/i)).toBeNull();
    expect(screen.queryByText(/^0 declared/)).toBeNull();
  });

  it("labels counts as declared things, never as a value", async () => {
    mockResults([WITH_INTERESTS]);
    render(<PoliticianExplorer />);
    await waitFor(() => expect(screen.getByText(/3 declared companies/)).toBeInTheDocument());
    expect(screen.getByText(/1 suburb/)).toBeInTheDocument();
  });

  it("renders search highlights as text, not as HTML", async () => {
    mockResults([WITH_INTERESTS]);
    const { container } = render(<PoliticianExplorer />);
    await waitFor(() => expect(container.querySelector("mark")).not.toBeNull());
    // The <em> markers must have been parsed away, not injected.
    expect(container.innerHTML).not.toContain("<em>");
    expect(container.querySelector("mark")?.textContent).toBe("Member");
  });

  it("labels an unrecorded party rather than guessing one", async () => {
    mockResults([NO_INTERESTS]);
    render(<PoliticianExplorer />);
    await waitFor(() => expect(screen.getByText("B Member")).toBeInTheDocument());
    expect(screen.queryByText("Independent")).toBeNull();
  });

  it("renders facet counts for filtering", async () => {
    mockResults([WITH_INTERESTS]);
    render(<PoliticianExplorer />);
    await waitFor(() => expect(screen.getByText("Party")).toBeInTheDocument());
    expect(screen.getByText("Chamber")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Labor\s*35/ })).toBeInTheDocument();
    // An absent party is a facet value in its own right, honestly labelled.
    expect(screen.getByRole("button", { name: /Not recorded\s*54/ })).toBeInTheDocument();
  });

  it("degrades honestly when search is unavailable", async () => {
    searchPoliticians.mockRejectedValue(new Error("boom"));
    render(<PoliticianExplorer />);
    // A search outage says nothing about the register, and the copy must not
    // imply anything is missing from it.
    await waitFor(() =>
      expect(screen.getByText(/nothing here is missing from the register/i)).toBeInTheDocument(),
    );
  });

  it("carries no currency or warning iconography beside a name", async () => {
    mockResults([WITH_INTERESTS, NO_INTERESTS]);
    const { container } = render(<PoliticianExplorer />);
    // "A Member" is split by its highlight (<span>A </span><mark>Member</mark>),
    // so wait on the unhighlighted row instead.
    await waitFor(() => expect(screen.getByText("B Member")).toBeInTheDocument());
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/[⚠🚨🔴🚩👀💰💵🪙💲]/u);
  });
});
