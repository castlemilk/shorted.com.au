import { render } from "@testing-library/react";

import { StatusChain } from "../status-chain";
import { RuleLegend } from "../picks-table";

function outcomes(container: HTMLElement): string[] {
  return [...container.querySelectorAll("[data-rule-status]")].map((dot) =>
    dot.getAttribute("data-rule-status"),
  ) as string[];
}

describe("StatusChain", () => {
  it("shows triggered as every core rule passing", () => {
    const { container } = render(<StatusChain status="triggered" />);
    expect(outcomes(container)).toEqual(["pass", "pass", "pass"]);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    expect(container.textContent).toBe("");
  });

  it("shows setup as every core rule but the trigger, and watch as a mixed trace", () => {
    expect(outcomes(render(<StatusChain status="setup" />).container)).toEqual([
      "pass",
      "pass",
      "fail",
    ]);
    expect(outcomes(render(<StatusChain status="watch" />).container)).toEqual([
      "pass",
      "fail",
      "unknown",
    ]);
  });
});

describe("RuleLegend key", () => {
  it("numbers the rules in dot order and mutes a scoring-only rule", () => {
    const { container, getByText } = render(
      <RuleLegend
        rules={[
          { id: "growth", title: "Explosive growth", core: true },
          { id: "rs", title: "Relative strength", core: false },
        ]}
      />,
    );
    const rings = [...container.querySelectorAll("span[aria-hidden='true']")].filter(
      (el) => /^\d$/.test(el.textContent ?? ""),
    );
    expect(rings.map((el) => el.textContent)).toEqual(["1", "2"]);
    expect(rings[0]!.className).not.toContain("border-dashed");
    expect(rings[1]!.className).toContain("border-dashed");
    expect(getByText("(scoring only)")).toHaveClass("sr-only");
    expect(container.textContent).toContain("Dots follow the rule order:");
    expect(container.textContent).toContain("Hover a dot for the evidence.");
  });
});
