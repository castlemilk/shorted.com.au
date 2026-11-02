import { render } from "@testing-library/react";
import { OwnershipPlate } from "../ownership-plate";

describe("OwnershipPlate", () => {
  it("reads as one sentence, its facts joined by a middle dot", () => {
    const { container } = render(
      <OwnershipPlate
        items={[
          { text: "Notices read to 2026-10-19", dateTime: "2026-10-19" },
          { text: "index fund files as at 2026-09-30", dateTime: "2026-09-30" },
        ]}
      />,
    );
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector("p")!.textContent).toBe(
      "Notices read to 2026-10-19 · index fund files as at 2026-09-30 · Not financial advice",
    );
  });

  it("sets each date the plate states as a time, and only that date", () => {
    const { container } = render(
      <OwnershipPlate items={[{ text: "Notices read to 2026-10-19", dateTime: "2026-10-19" }]} />,
    );
    const time = container.querySelector("time");
    expect(time).toHaveAttribute("datetime", "2026-10-19");
    expect(time!.textContent).toBe("2026-10-19");
  });

  it("sets both dates of a range as times, in the plate's date classes", () => {
    const { container } = render(<OwnershipPlate items={[{ text: "index fund files as at 2026-09-30 to 2026-10-19" }]} />);
    const times = Array.from(container.querySelectorAll("time"));
    expect(times.map((time) => time.getAttribute("datetime"))).toEqual(["2026-09-30", "2026-10-19"]);
    for (const time of times) {
      expect(time).toHaveClass("font-medium", "text-foreground", "tabular-nums");
    }
  });

  it("always ends with the disclaimer, even with no facts", () => {
    const { container, rerender } = render(<OwnershipPlate items={[{ text: "ASIC shorts T+4" }]} />);
    const last = container.querySelector("p")!.lastElementChild;
    expect(last).toHaveAttribute("href", "/disclaimer");
    expect(last).toHaveTextContent("Not financial advice");

    rerender(<OwnershipPlate items={[]} />);
    expect(container.querySelector("p")!.textContent).toBe("Not financial advice");
  });

  it("links a fact that carries an href", () => {
    const { container } = render(<OwnershipPlate items={[{ text: "Method", href: "/ownership#method" }]} />);
    const link = container.querySelector('a[href="/ownership#method"]');
    expect(link).toHaveTextContent("Method");
  });
});
