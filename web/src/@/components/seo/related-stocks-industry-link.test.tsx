import { render, screen } from "@testing-library/react";

import { RelatedStocks } from "./related-stocks";

const six = Array.from({ length: 6 }, (_, i) => ({
  code: `S${i}`,
  name: `Stock ${i}`,
  shortPercent: 5,
  industry: "Not Applic",
}));

describe("RelatedStocks industry link", () => {
  it("links a real industry", () => {
    render(<RelatedStocks stocks={six} industrySlug="materials" />);
    expect(screen.getByRole("link", { name: /View all stocks in this industry/ })).toHaveAttribute(
      "href",
      "/industry/materials",
    );
  });

  it.each(["not-applic", "class-pend", "other", ""])(
    "never emits a link to the placeholder industry %j",
    (slug) => {
      render(<RelatedStocks stocks={six} industrySlug={slug} />);
      expect(screen.queryByRole("link", { name: /View all stocks in this industry/ })).toBeNull();
    },
  );
});
