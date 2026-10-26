import { render, screen } from "@testing-library/react";

/**
 * The stock's social card prints the short percentage to one decimal. ANT,
 * 164 shares short, read "0.0%": a measured zero for a reported position. It
 * follows the page's one rule (~/@/lib/stocks/short-percent): such a position
 * reads "<0.1%", and only no position at all reads "N/A".
 */

const getStock = jest.fn();

jest.mock("next/og", () => ({
  ImageResponse: class MockImageResponse {
    element: React.ReactElement;
    constructor(element: React.ReactElement) {
      this.element = element;
    }
  },
}));
// The background and our mark are read off disk; their bytes are not what
// these tests look at.
jest.mock("node:fs/promises", () => ({ readFile: jest.fn(async () => Buffer.from("png")) }));
jest.mock("~/@/lib/og/card", () => ({
  getCompanyLogo: async () => ({ src: "", aspect: 1 }),
  OgLogoChip: () => null,
}));
jest.mock("~/app/actions/getStock", () => ({ getStock: (code: string) => getStock(code) }));

import Image from "../opengraph-image";

async function cardFor(stock: Record<string, unknown> | undefined) {
  getStock.mockResolvedValue(stock);
  const res = (await Image({ params: Promise.resolve({ stockCode: "ant" }) })) as unknown as {
    element: React.ReactElement;
  };
  return render(res.element);
}

describe("stock social card", () => {
  beforeEach(() => getStock.mockReset());

  it("prints the short percentage to one decimal", async () => {
    await cardFor({ name: "DroneShield", percentageShorted: 9.4215, logoUrl: "" });
    expect(screen.getByText("9.4%")).toBeInTheDocument();
    expect(getStock).toHaveBeenCalledWith("ANT");
  });

  it("puts a position too small for one decimal under 0.1%, never at 0.0%", async () => {
    const { container } = await cardFor({
      name: "Arcadia Minerals",
      percentageShorted: 0.0000205,
      logoUrl: "",
    });
    expect(screen.getByText("<0.1%")).toBeInTheDocument();
    expect(container.textContent).not.toContain("0.0%");
  });

  it.each([
    ["no position", { name: "Arcadia Minerals", percentageShorted: 0, logoUrl: "" }],
    ["no stock", undefined],
  ])("reads N/A for %s", async (_name, stock) => {
    await cardFor(stock);
    expect(screen.getByText("N/A")).toBeInTheDocument();
  });
});
