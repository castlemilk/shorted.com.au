/// <reference types="jest" />

import React from "react";
import { render } from "@testing-library/react";
import { StockLogoImg } from "../stock-logo-img";

const LOGO = "https://storage.googleapis.com/shorted-company-logos/logos/BHP.png";

function srcSetCandidates(img: HTMLImageElement): string[] {
  return (img.getAttribute("srcset") ?? "").split(", ").filter(Boolean);
}

describe("StockLogoImg", () => {
  // With `sizes` on a fixed-size next/image the srcset listed every configured
  // width: 16 candidates up to 3840w, ~2KB per tag, 747KB of srcset on
  // /reports/weekly. A fixed width and height is a 1x/2x pair.
  it("emits a 1x/2x srcset for a 20px chip", () => {
    const { container } = render(<StockLogoImg src={LOGO} px={20} />);
    const img = container.querySelector("img")!;

    expect(img).not.toHaveAttribute("sizes");
    const candidates = srcSetCandidates(img);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatch(/&w=32&q=75 1x$/);
    expect(candidates[1]).toMatch(/&w=48&q=75 2x$/);
    expect(img).toHaveAttribute("width", "20");
    expect(img).toHaveAttribute("height", "20");
    expect(img.outerHTML.length).toBeLessThan(700);
  });

  it("emits a 1x/2x srcset for a 28px chip", () => {
    const { container } = render(<StockLogoImg src={LOGO} px={28} />);
    const candidates = srcSetCandidates(container.querySelector("img")!);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatch(/&w=32&q=75 1x$/);
    expect(candidates[1]).toMatch(/&w=64&q=75 2x$/);
  });

  it("renders a host next/image cannot optimise as a plain img", () => {
    const { container } = render(
      <StockLogoImg src="https://example.com/logo.svg" px={20} />,
    );
    const img = container.querySelector("img")!;
    expect(img).toHaveAttribute("src", "https://example.com/logo.svg");
    expect(img).not.toHaveAttribute("srcset");
  });
});
