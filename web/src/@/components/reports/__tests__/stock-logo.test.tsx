/// <reference types="jest" />

import React from "react";
import { render } from "@testing-library/react";
import { StockLogo, hueFromCode } from "../stock-logo";

describe("hueFromCode", () => {
  it("is deterministic and case-insensitive", () => {
    expect(hueFromCode("BHP")).toBe(hueFromCode("BHP"));
    expect(hueFromCode("bhp")).toBe(hueFromCode("BHP"));
  });

  it("stays within the hue wheel", () => {
    for (const code of ["BHP", "CBA", "PLS", "ZIP", "A", "XXXX"]) {
      const hue = hueFromCode(code);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });
});

describe("StockLogo", () => {
  it("renders the letter-avatar fallback when logoUrl is empty", () => {
    const { container, getByTestId } = render(<StockLogo code="BHP" />);
    expect(getByTestId("stock-logo-fallback").textContent).toBe("BH");
    expect(container.querySelector("img")).toBeNull();
  });

  it("layers the logo image over the fallback when logoUrl is provided", () => {
    const { container, getByTestId } = render(
      <StockLogo code="BHP" logoUrl="https://example.com/bhp.png" />,
    );
    const img = container.querySelector("img")!;
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("https://example.com/bhp.png");
    // Fallback stays behind the image so a failed load degrades gracefully
    expect(getByTestId("stock-logo-fallback")).not.toBeNull();
  });

  it("uses a deterministic background hue for the fallback avatar", () => {
    const first = render(<StockLogo code="PLS" />);
    const firstEl = first.getByTestId("stock-logo-fallback");
    const firstColor = firstEl.style.backgroundColor;
    first.unmount();

    const second = render(<StockLogo code="PLS" />);
    const secondEl = second.getByTestId("stock-logo-fallback");
    expect(firstColor).toBe(secondEl.style.backgroundColor);
    expect(firstColor).not.toBe("");
  });

  it("respects the size variants", () => {
    const sm = render(<StockLogo code="CBA" size="sm" />);
    expect(sm.getByTestId("stock-logo").style.width).toBe("20px");
    sm.unmount();

    const md = render(<StockLogo code="CBA" size="md" />);
    expect(md.getByTestId("stock-logo").style.width).toBe("28px");
  });
});
