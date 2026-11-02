import { render, screen } from "@testing-library/react";
import { KindBadge } from "../kind-badge";

describe("KindBadge", () => {
  it("names a kind and draws its swatch beside the name", () => {
    const { container } = render(<KindBadge kind="super_fund" />);
    expect(screen.getByText("Super fund")).toBeInTheDocument();
    expect(container.querySelector("span[aria-hidden]")).toHaveClass("bg-[#87A96B]");
  });

  it("names a kind it does not know as unclassified, with the unclassified swatch", () => {
    const { container } = render(<KindBadge kind="family_trust" />);
    expect(screen.getByText("Unclassified")).toBeInTheDocument();
    expect(container.querySelector("span[aria-hidden]")).toHaveClass("bg-[#E5E1DC]");
  });
});
