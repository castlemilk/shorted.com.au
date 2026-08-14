/**
 * The rail's "Most-declared companies" list.
 *
 * Every assertion here is about what the list may SAY, not about how it looks:
 *
 *   - the right-hand figure is a count of PEOPLE, in words. "12" alone beside a
 *     company is a number a reader is free to read as a quantity or a value, and
 *     the registers record neither. One member reads "1 member", not "1 members"
 *     and not a bare digit.
 *   - SILENCE IS THE EMPTY STATE. No companies renders no heading: a heading over
 *     an empty list reads as a claim that parliament declares nothing.
 *   - no currency and no characterisation. This surface sits on the same page as
 *     named members, so a "$", or a word like profit, insider, worth or risk,
 *     would carry an imputation the count cannot support.
 */

import { render, screen } from "@testing-library/react";

import { TopCompanies, type TopCompanyRow } from "../explorer/top-companies";

const STOCKS: TopCompanyRow[] = [
  { stockCode: "BHP", companyName: "BHP Group Limited", politicianCount: 12 },
  { stockCode: "CBA", companyName: "Commonwealth Bank of Australia", politicianCount: 1 },
];

describe("most-declared companies", () => {
  it("links each company to its stock page", () => {
    render(<TopCompanies stocks={STOCKS} />);

    expect(screen.getByRole("link", { name: /BHP/ })).toHaveAttribute("href", "/shorts/BHP");
    expect(screen.getByRole("link", { name: /CBA/ })).toHaveAttribute("href", "/shorts/CBA");
    expect(screen.getByText("BHP Group Limited")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Most-declared companies" })).toBeInTheDocument();
  });

  it("states the figure as a count of members, singular when it is one", () => {
    render(<TopCompanies stocks={STOCKS} />);

    expect(screen.getByText("12 members")).toBeInTheDocument();
    expect(screen.getByText("1 member")).toBeInTheDocument();
    expect(screen.queryByText("1 members")).toBeNull();
  });

  it("says the count is not an amount", () => {
    render(<TopCompanies stocks={STOCKS} />);

    expect(screen.getByText("Counted by members declaring. Not an amount.")).toBeInTheDocument();
  });

  it("renders nothing at all when there are no companies", () => {
    const { container } = render(<TopCompanies stocks={[]} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText("Most-declared companies")).toBeNull();
  });

  it("drops a row with no code rather than rendering a blank line", () => {
    render(
      <TopCompanies
        stocks={[{ stockCode: "", companyName: "Unresolved", politicianCount: 4 }, ...STOCKS]}
      />,
    );

    expect(screen.queryByText("Unresolved")).toBeNull();
    expect(screen.getAllByRole("link")).toHaveLength(2);
  });

  it("publishes no currency and no characterisation of a holding", () => {
    const { container } = render(<TopCompanies stocks={STOCKS} />);

    const text = container.textContent ?? "";
    expect(text).not.toContain("$");
    expect(text).not.toMatch(/profit|insider|worth|risk/i);
  });
});
