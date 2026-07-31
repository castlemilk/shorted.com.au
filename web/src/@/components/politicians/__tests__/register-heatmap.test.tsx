/**
 * The heatmap is an aggregate view of what named people declare, grouped by
 * political party. That makes it the highest-risk chart in the subsystem for
 * editorial rule 2 (juxtaposition, not accusation) and rule 5 (never magnitude),
 * so both are pinned here rather than left to review.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";

import { RegisterHeatmap } from "../register-heatmap";

const CELLS = [
  { partyAb: "ALP", industry: "Banks", people: 17, companies: 6 },
  { partyAb: "LP", industry: "Banks", people: 4, companies: 3 },
  // The case the tooltip design exists for: many members, ONE company.
  { partyAb: "ALP", industry: "Telecommunication Services", people: 12, companies: 1 },
  // A member with no recorded party. Not a guess, not "Independent".
  { partyAb: "", industry: "Banks", people: 27, companies: 8 },
];

const INDUSTRIES = [
  { industry: "Banks", people: 48, companies: 8 },
  { industry: "Telecommunication Services", people: 12, companies: 1 },
];

const PARTIES = [
  { partyAb: "", people: 27 },
  { partyAb: "ALP", people: 29 },
  { partyAb: "LP", people: 4 },
];

function renderHeatmap(omitted = 0) {
  return render(
    <RegisterHeatmap
      cells={CELLS}
      industries={INDUSTRIES}
      parties={PARTIES}
      industriesOmitted={omitted}
    />,
  );
}

describe("register heatmap", () => {
  it("renders a member count in every populated cell, not only on hover", () => {
    // This is the relief the contrast check obligates for the pale steps: the
    // chart has to be readable printed, in forced-colors, and by a reader who
    // cannot separate two adjacent ambers.
    renderHeatmap();
    expect(screen.getByLabelText("Labor, Banks: 17 members")).toHaveTextContent("17");
    expect(screen.getByLabelText("Liberal, Banks: 4 members")).toHaveTextContent("4");
  });

  it("labels an unrecorded party as not recorded, never as a party", () => {
    renderHeatmap();
    expect(screen.getAllByText("Not recorded").length).toBeGreaterThan(0);
    // Party reaches the register through an electorate join, so absence is real.
    // Calling it Independent would attribute a party to named individuals.
    expect(screen.queryByText("Independent")).toBeNull();
  });

  it("distinguishes many-members-one-company from many-members-many-companies", () => {
    renderHeatmap();
    const cell = screen.getByLabelText("Labor, Telecommunication Services: 12 members");
    fireEvent.mouseEnter(cell);
    // 12 members holding ONE company is a different fact from 12 holding twelve,
    // and a single shade cannot say which. The tooltip carries both numbers and
    // the singular "company" rather than "different companies".
    const tip = screen.getByText(/members declare/).closest("p") as HTMLElement;
    expect(tip.textContent).toMatch(/12\s*members declare an interest in\s*1\s*company/);
    expect(tip.textContent).not.toMatch(/different companies/);

    fireEvent.mouseEnter(screen.getByLabelText("Labor, Banks: 17 members"));
    const many = screen.getByText(/members declare/).closest("p") as HTMLElement;
    expect(many.textContent).toMatch(/6\s*different companies/);
  });

  it("says plainly when a cell is empty rather than shading it faintly", () => {
    renderHeatmap();
    const empty = screen.getByLabelText("Liberal, Telecommunication Services: 0 members");
    fireEvent.mouseEnter(empty);
    expect(screen.getByText(/no declared interests/i)).toBeInTheDocument();
  });

  it("offers a table view of the same numbers", () => {
    renderHeatmap();
    fireEvent.click(screen.getByRole("button", { name: /show as table/i }));
    const table = screen.getAllByRole("table")[0]!;
    expect(within(table).getByText("Banks")).toBeInTheDocument();
    expect(within(table).getAllByText("17").length).toBeGreaterThan(0);
  });

  it("states what the industry cap dropped instead of truncating silently", () => {
    const { container } = renderHeatmap(19);
    // A heatmap showing 2 of 21 industries without saying so reads as the whole
    // picture. The count is its own element, so assert on the joined text.
    expect(container.textContent).toMatch(
      /Showing the 2 most-declared industries\.\s*19\s*further industries are declared but not shown/,
    );
  });

  it("says the counts are of people, never of value", () => {
    renderHeatmap();
    expect(screen.getByText(/Counts are of PEOPLE/)).toBeInTheDocument();
    expect(screen.getByText(/never how much/i)).toBeInTheDocument();
  });

  it("renders no currency amount and no warning iconography", () => {
    const { container } = renderHeatmap();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/[⚠🚨🔴🚩👀💰💵🪙💲]/u);
  });

  it("uses no accusatory verb", () => {
    const { container } = renderHeatmap();
    expect(container.textContent ?? "").not.toMatch(
      /\b(profit\w*|insider|corrupt\w*|bet against|rort\w*|kickback)\b/i,
    );
  });
});
