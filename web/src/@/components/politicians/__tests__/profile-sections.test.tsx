/**
 * The profile's server-rendered rail and service line.
 *
 * The assertions that matter here are editorial, not visual: a member's seat and
 * party change between parliaments and the page must say so rather than flatten
 * five stints into one current label; a register addition and a removal must
 * look identical, because a removal can mean an asset was disposed of, a
 * declaration was corrected, or the member left parliament, and a green/red pair
 * beside a named person picks one of those readings; and a truncated list must
 * say it is truncated.
 */

import { render, screen, within } from "@testing-library/react";

import {
  IndustryBars,
  RecentChanges,
  ServiceHistory,
  SourceDocuments,
  groupTerms,
} from "../profile/sections";

const HOUSE_TERM = {
  chamber: "house",
  division: "Grayndler",
  stateCode: "NSW",
  partyAb: "ALP",
};

describe("profile service history", () => {
  it("collapses consecutive terms in the same seat and party into one stint", () => {
    expect(
      groupTerms([
        { parliament: 45, ...HOUSE_TERM },
        { parliament: 46, ...HOUSE_TERM },
        { parliament: 47, ...HOUSE_TERM },
      ]),
    ).toEqual([
      { from: 45, to: 47, role: "Member for Grayndler", party: "Labor", chamber: "house" },
    ]);
  });

  it("keeps a party change as its own stint", () => {
    const groups = groupTerms([
      { parliament: 46, ...HOUSE_TERM },
      { parliament: 47, ...HOUSE_TERM, partyAb: "IND" },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[1]?.party).toBe("Independent");
  });

  it("labels an unrecorded party as not recorded, never as a party", () => {
    // Party reaches the register through an electorate join, not the APH
    // listing, so absence is real. "Unknown" (the palette's fallback) and
    // "Other" (the colour bucket) both read as a party here.
    render(<ServiceHistory terms={[{ parliament: 44, ...HOUSE_TERM, partyAb: "" }]} />);
    expect(screen.getByText(/Party not recorded/)).toBeInTheDocument();
    expect(screen.queryByText(/Unknown/)).toBeNull();
  });

  it("names the chamber's own role", () => {
    render(
      <ServiceHistory
        terms={[
          { parliament: 48, chamber: "senate", division: "", stateCode: "WA", partyAb: "LP" },
        ]}
      />,
    );
    expect(screen.getByText(/Senator for WA/)).toBeInTheDocument();
  });

  it("renders nothing when there are no terms", () => {
    const { container } = render(<ServiceHistory terms={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("profile industry bars", () => {
  it("counts distinct companies and says so, never an amount", () => {
    const { container } = render(
      <IndustryBars
        industries={[
          { industry: "Banks", companyCount: 3 },
          { industry: "Materials", companyCount: 1 },
        ]}
      />,
    );
    expect(screen.getByText("Declared companies by industry")).toBeInTheDocument();
    expect(within(screen.getByRole("table")).getByText("Banks")).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).toMatch(/count of companies, not an amount/i);
    expect(text).not.toMatch(/\$\s*\d/);
  });

  it("renders nothing rather than an empty axis", () => {
    const { container } = render(<IndustryBars industries={[{ industry: "Banks", companyCount: 0 }]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("profile recent changes", () => {
  const change = (id: string, added: boolean) => ({
    id,
    added,
    date: "12 Mar 2026",
    declaredText: `Entry ${id}`,
    itemLabel: "Shareholdings",
    sourceUrl: "https://www.aph.gov.au/Register/48p/A/Member_48P.pdf",
  });

  it("renders an addition and a removal identically", () => {
    const { container } = render(
      <RecentChanges changes={[change("a", true), change("b", false)]} />,
    );
    expect(screen.getByText("added")).toBeInTheDocument();
    expect(screen.getByText("removed")).toBeInTheDocument();
    // No outcome colouring: a removal is a register event, not a transaction.
    expect(container.innerHTML).not.toMatch(/emerald|text-red|text-green/);
  });

  it("states the truncation instead of stopping silently", () => {
    const many = Array.from({ length: 14 }, (_, i) => change(String(i), i % 2 === 0));
    render(<RecentChanges changes={many} />);
    expect(screen.getAllByText(/^Entry /)).toHaveLength(10);
    expect(
      screen.getByText(/Showing the 10 most recent of 14 recorded changes/),
    ).toBeInTheDocument();
  });

  it("says the dates are register dates, not transaction dates", () => {
    render(<RecentChanges changes={[change("a", false)]} />);
    expect(screen.getByText(/not transaction dates/)).toBeInTheDocument();
    expect(screen.queryByText(/Showing the/)).toBeNull();
  });
});

describe("profile source documents", () => {
  it("deep-links aph.gov.au and labels the document by parliament and chamber", () => {
    render(
      <SourceDocuments
        documents={[
          {
            label: "48P statement",
            sourceUrl: "https://www.aph.gov.au/Register/48p/A/Member_48P.pdf",
            parliament: 48,
            chamber: "house",
          },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: "48P statement" });
    expect(link).toHaveAttribute("href", "https://www.aph.gov.au/Register/48p/A/Member_48P.pdf");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(screen.getByText(/48th Parliament · House of Representatives/)).toBeInTheDocument();
  });

  it("falls back to the label the URL encodes when the document has none", () => {
    render(
      <SourceDocuments
        documents={[
          {
            label: "",
            sourceUrl: "https://www.aph.gov.au/Register/45p/B/Member_45P.pdf",
            parliament: 0,
            chamber: "",
          },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "45P" })).toBeInTheDocument();
  });
});
