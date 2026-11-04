/// <reference types="jest" />

import { render } from "@testing-library/react";
import { SectorIcon, sectorIconName } from "../sector-icon";

describe("sector icons (spec 14.2)", () => {
  it("draws the landing page's sector image for an industry, in a reserved box", () => {
    const { container } = render(<SectorIcon industry="Banks" size={20} />);
    const box = container.querySelector("[data-sector-icon]") as HTMLElement;
    expect(box.getAttribute("data-sector-icon")).toBe("banks");
    expect(box.style.width).toBe("20px");
    expect(box.getAttribute("aria-hidden")).toBe("true");
    const img = container.querySelector("img") as HTMLImageElement;
    expect(decodeURIComponent(img.getAttribute("src") ?? "")).toContain("/assets/sectors-v2/banks.webp");
    expect(img.getAttribute("alt")).toBe("");
  });

  it("maps placeholders, unknowns and missing industries to other, never a neighbouring sector", () => {
    for (const value of ["", "Not Applic", "Class Pend", "Banks & Lenders", null, undefined]) {
      expect(sectorIconName(value)).toBe("other");
    }
    expect(sectorIconName("Materials")).toBe("materials");
    expect(sectorIconName("Equity Real Estate Investment Trusts (REITs)")).toBe("reits");
  });
});
