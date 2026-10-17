import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { SuburbContextBar } from "../suburb-context-bar";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));
// The shared setup stubs Radix context; the state Select is not under test.
jest.mock("@/components/ui/select", () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Select: Pass, SelectContent: () => null, SelectItem: () => null, SelectTrigger: Pass, SelectValue: Pass };
});

describe("SuburbContextBar council link", () => {
  it("links the suburb's council hub between the state and the suburb", () => {
    render(
      <SuburbContextBar
        stateCode="NSW"
        suburbName="Kingsgrove"
        salCode="12166"
        council={{ name: "Canterbury-Bankstown", href: "/housing/nsw/council/canterbury-bankstown" }}
      />,
    );
    const link = screen.getByRole("link", { name: "Canterbury-Bankstown" });
    expect(link.getAttribute("href")).toBe("/housing/nsw/council/canterbury-bankstown");
    const trail = screen.getByRole("navigation", { name: "Breadcrumb" }).textContent ?? "";
    expect(trail.indexOf("New South Wales")).toBeLessThan(trail.indexOf("Canterbury-Bankstown"));
    expect(trail.indexOf("Canterbury-Bankstown")).toBeLessThan(trail.indexOf("Kingsgrove"));
  });

  it("renders no council segment when the council has no page", () => {
    render(<SuburbContextBar stateCode="NSW" suburbName="Kingsgrove" salCode="12166" />);
    expect(screen.queryByRole("link", { name: /council/i })).toBeNull();
    expect(screen.getByRole("navigation", { name: "Breadcrumb" }).querySelectorAll("a")).toHaveLength(1);
  });
});
