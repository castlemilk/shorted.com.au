import { render, screen, within } from "@testing-library/react";

import { InsightCards } from "../insight-cards";
import { insightsPage } from "~/@/lib/ownership/insights/__tests__/fixtures";

describe("InsightCards", () => {
  it("ranks the window's rises, falls, crowded sectors, index ownership and stated moves, each dated", () => {
    const { container } = render(<InsightCards page={insightsPage()} />);
    const rises = screen.getByRole("heading", { name: "Largest rises in index fund shares" }).closest("section")!;
    expect(within(rises).getAllByRole("listitem")[0]).toHaveTextContent("BHP");
    expect(within(rises).getByText("+$400.0M")).toBeInTheDocument();
    expect(within(rises).getByText(/new position/)).toBeInTheDocument();
    const falls = screen.getByRole("heading", { name: "Largest falls in index fund shares" }).closest("section")!;
    expect(within(falls).getByText("−$100.0M")).toBeInTheDocument();
    const crowded = screen.getByRole("heading", { name: "Most crowded sectors" }).closest("section")!;
    expect(within(crowded).getAllByRole("listitem")).toHaveLength(1);
    expect(within(crowded).getByRole("link", { name: "Materials" })).toHaveAttribute("rel", "nofollow");
    const owned = screen.getByRole("heading", { name: "Most owned by index funds" }).closest("section")!;
    expect(within(owned).getAllByRole("listitem")[0]).toHaveTextContent("2.52%");
    expect(container.querySelectorAll("time").length).toBeGreaterThan(6);
    expect(container.textContent).toMatch(/what the notices disclose, not a share of the company/);
    expect(container.textContent).not.toMatch(/—|\bsold\b|\bsale\b|index ETF/i);
  });

  it("says n/a, not zero, when no fund has two files in the window", () => {
    const page = insightsPage();
    page.window = { ...page.window, fundsCompared: 0 };
    render(<InsightCards page={page} />);
    expect(screen.getAllByText("n/a: no index fund has two files in this window.")).toHaveLength(2);
  });
});
