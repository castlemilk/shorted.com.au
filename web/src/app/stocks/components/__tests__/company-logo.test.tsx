/// <reference types="jest" />

import React from "react";
import { render } from "@testing-library/react";
import { CompanyLogo } from "../company-logo";

describe("CompanyLogo", () => {
  // width 96 + sizes="48px" made next/image list every configured width: 16
  // candidates up to 3840w, about 2 KB of srcset per directory logo. Dropping
  // `sizes` alone would have kept width 96, a 96w/256w pair; the tile draws the
  // logo at 48x32 (56x40 less p-1).
  it("emits a 1x/2x srcset for the tile's 48px content box", () => {
    const { container } = render(
      <CompanyLogo
        src="https://storage.googleapis.com/shorted-company-logos/logos/BHP.png"
        code="BHP"
      />,
    );
    const img = container.querySelector("img")!;

    expect(img).not.toHaveAttribute("sizes");
    const candidates = (img.getAttribute("srcset") ?? "").split(", ");
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatch(/&w=48&q=75 1x$/);
    expect(candidates[1]).toMatch(/&w=96&q=75 2x$/);
    expect(img).toHaveAttribute("width", "48");
    expect(img).toHaveAttribute("height", "32");
    // Still fills the tile and scales a small mark up.
    expect(img).toHaveClass("h-full", "w-full", "object-contain");
  });

  it("serves an SVG logo unoptimised, with no srcset", () => {
    const { container } = render(
      <CompanyLogo
        src="https://storage.googleapis.com/shorted-company-logos/logos/svg/CBA.svg"
        code="CBA"
      />,
    );
    const img = container.querySelector("img")!;

    expect(img).not.toHaveAttribute("srcset");
    expect(img.getAttribute("src")).toBe(
      "https://storage.googleapis.com/shorted-company-logos/logos/svg/CBA.svg?v=2",
    );
  });
});
