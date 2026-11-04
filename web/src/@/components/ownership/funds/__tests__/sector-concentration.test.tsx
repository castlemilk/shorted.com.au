/// <reference types="jest" />

import { render, screen } from "@testing-library/react";
import { SectorConcentration } from "../sector-concentration";

describe("the sector concentration bars (spec 14.3, Fund page)", () => {
  it("names each sector as a link that focuses the portfolio map on it", () => {
    render(<SectorConcentration sectors={[{ industry: "Banks", weightPct: 30 }]} />);
    const link = screen.getByRole("link", { name: /^Focus / });
    expect(link).toHaveAttribute("href", "?tab=portfolio&focus=Banks");
  });
});
