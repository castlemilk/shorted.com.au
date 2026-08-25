import { render, screen } from "@testing-library/react";

import {
  RelatedThemesForIndustry,
  StockThemeChips,
} from "~/@/components/themes/theme-chips";

describe("StockThemeChips", () => {
  it("links a member code to every basket it belongs to", () => {
    render(<StockThemeChips stockCode="PLS" />);

    expect(screen.getByText("Part of")).toBeInTheDocument();
    const hrefs = screen
      .getAllByRole("link")
      .map((el) => el.getAttribute("href"));
    expect(hrefs).toEqual(["/themes/lithium", "/themes/battery-metals"]);
    expect(screen.getByRole("link", { name: "Lithium" })).toBeInTheDocument();
  });

  it("renders nothing for a code in no basket", () => {
    const { container } = render(<StockThemeChips stockCode="ZZZZ" />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("RelatedThemesForIndustry", () => {
  it("lists the themes that claim the industry", () => {
    render(<RelatedThemesForIndustry industry="Banks" />);
    expect(
      screen.getByRole("link", { name: "ASX Bank Stocks" }),
    ).toHaveAttribute("href", "/themes/banks");
  });

  it("renders nothing for an industry no theme claims", () => {
    const { container } = render(
      <RelatedThemesForIndustry industry="Utilities" />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
