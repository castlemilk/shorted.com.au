/**
 * DeclaredEntity has to describe a row a reader can check against the PDF.
 *
 * The failure this pins is editorial, not visual: "not matched to an ASX
 * listing" next to "The Indinup Trust" reports a system failure that never
 * happened — a trust cannot have a ticker — and leaves a reader unable to tell
 * it apart from a company we genuinely could not match.
 */

import { render, screen } from "@testing-library/react";

import { DeclaredEntity } from "../compliance";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const NOT_MATCHED = /not matched to an ASX listing/i;

describe("DeclaredEntity", () => {
  it("links a publishably resolved holding to its stock page", () => {
    render(<DeclaredEntity declaredText="BHP Group" stockCode="BHP" companyName="BHP Group" entityKind="listed" />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/shorts/BHP");
    expect(screen.queryByText(NOT_MATCHED)).toBeNull();
  });

  it.each([
    ["family_trust", "Family trust"],
    ["private_company", "Private company"],
    ["smsf", "Self-managed super fund"],
    ["managed_fund", "Managed fund"],
    ["foreign", "Foreign listing"],
  ])("labels %s as %s and never apologises for the missing ticker", (kind, label) => {
    render(<DeclaredEntity declaredText="The Indinup Trust" entityKind={kind} />);
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText("The Indinup Trust")).toBeInTheDocument();
    expect(screen.queryByText(NOT_MATCHED)).toBeNull();
  });

  it("keeps the unmatched wording for a listed candidate, which is the case it was written for", () => {
    render(<DeclaredEntity declaredText="AGL Ltd" entityKind="listed" />);
    expect(screen.getByText(NOT_MATCHED)).toBeInTheDocument();
  });

  /**
   * This used to assert the OPPOSITE, and that fallback was the single
   * highest-volume wrong claim on the whole surface.
   *
   * Only items 1 (shareholdings) and 4 (directorships) are ever classified —
   * they are the only items with a security candidate. The fold hardcoded
   * 'listed' for every other item, so 666 published rows and 3,174 rows in the
   * /politicians/changes feed — superannuation accounts, family trusts, gifts,
   * sponsored travel — carried "not matched to an ASX listing". Nothing about
   * "REST superannuation fund" was ever a match attempt, so there was no
   * failure to report.
   *
   * The apology now requires an EXPLICIT 'listed' and must never return by
   * fallthrough.
   */
  it.each([
    ["REST superannuation fund", undefined],
    ["Hostplus superannuation fund (self)", ""],
    ["Gold bullion - Held in TAY Super (SMSF)", "unclassified"],
  ])("makes no ASX-matching claim about %s when the kind is not 'listed'", (text, kind) => {
    render(<DeclaredEntity declaredText={text} entityKind={kind} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByText(NOT_MATCHED)).toBeNull();
  });

  it("states no quantity, value or currency for any kind", () => {
    for (const kind of ["listed", "family_trust", "private_company", "smsf", "managed_fund", "foreign"]) {
      const { container, unmount } = render(
        <DeclaredEntity declaredText="Sample Holdings Pty Ltd" entityKind={kind} />,
      );
      expect(container.textContent ?? "").not.toMatch(/[$€£]|\bworth\b|\bvalued\b/i);
      unmount();
    }
  });
});
