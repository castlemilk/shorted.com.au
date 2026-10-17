import { render, screen } from "@testing-library/react";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { IndustryBreakdown } from "../industry-breakdown";

const row = (industry: string, avgShortPct: number) => ({
  industry,
  avgShortPct,
  wowChange: 0.02,
  stockCount: 3,
  topStockCode: "4DX",
  topStockPct: 11.12,
});

describe("IndustryBreakdown", () => {
  it("gives an ASX placeholder no row: it is not an industry", () => {
    // The week 41 report on production (2026-10-14) ranked "Class Pend", the
    // three stocks whose classification the ASX had not settled, as an industry.
    const { container } = render(
      <IndustryBreakdown
        industries={[
          row("Health Care Equipment & Services", 2.1),
          row("Class Pend", 2.01),
          row("Not Applic", 0.4),
        ]}
      />,
    );

    expect(screen.getByText("Health Care Equipment & Services")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(container.textContent).not.toMatch(/not applic|class pend/i);
  });

  it("renders nothing when every row is a placeholder", () => {
    const { container } = render(<IndustryBreakdown industries={[row("Class Pend", 2.01)]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
