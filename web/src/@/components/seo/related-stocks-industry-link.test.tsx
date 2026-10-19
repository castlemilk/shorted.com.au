import { render, screen, within } from "@testing-library/react";

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

describe("RelatedStocks rows", () => {
  const stocks = [
    { code: "EOS", name: "EOS", shortPercent: 10.9, industry: "Capital Goods", logoUrl: "https://example.com/EOS.png" },
    { code: "SLX", name: "Silex Systems", shortPercent: 8.2, industry: "Capital Goods" },
  ];

  it("leads each row with the company's logo chip, its letter avatar behind", () => {
    render(<RelatedStocks stocks={stocks} />);
    const eos = screen.getByRole("link", { name: /EOS/ });
    expect(eos.querySelector("img")).toHaveAttribute("src", "https://example.com/EOS.png");
    expect(within(eos).getByTestId("stock-logo-fallback")).toHaveTextContent("EO");
    // No logo held: the avatar alone, and no request for one that 404s.
    const slx = screen.getByRole("link", { name: /SLX/ });
    expect(slx.querySelector("img")).toBeNull();
    expect(within(slx).getByTestId("stock-logo-fallback")).toHaveTextContent("SL");
  });

  it("prints a name under the code only when it is not the code again", () => {
    render(<RelatedStocks stocks={stocks} />);
    expect(screen.getByRole("link", { name: /SLX/ })).toHaveTextContent("Silex Systems");
    expect(screen.getAllByText("EOS")).toHaveLength(1);
  });
});
