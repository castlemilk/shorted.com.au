import { render, screen } from "@testing-library/react";
import { CompanyLogo } from "../company-logo";

describe("CompanyLogo", () => {
  it("renders the normalized logo as a plain img (no next/image host allowlist risk)", () => {
    render(<CompanyLogo stockCode="LOT" companyName="Lotus Resources" />);

    const img = screen.getByAltText(
      "Lotus Resources logo",
    ) as HTMLImageElement;
    expect(img).toBeInTheDocument();
    expect(img.tagName).toBe("IMG");
    expect(img.src).toContain("/logos-normalized/LOT.png");
    expect(img.getAttribute("width")).toBe("70");
    expect(img.getAttribute("height")).toBe("70");
    // Plain <img> means no next/image preload/priority semantics at all.
    expect(img.getAttribute("fetchpriority")).toBeNull();
  });
});
