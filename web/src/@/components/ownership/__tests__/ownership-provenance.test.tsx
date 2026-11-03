import { render, screen } from "@testing-library/react";
import { OwnershipReportError, OwnershipSourceLines } from "../ownership-provenance";

describe("OwnershipReportError", () => {
  it("addresses the report to the error desk, with its subject encoded", () => {
    render(<OwnershipReportError subject="Ownership data: BHP register" />);
    expect(screen.getByRole("link", { name: "Report an error" })).toHaveAttribute(
      "href",
      "mailto:support@shorted.com.au?subject=Ownership%20data%3A%20BHP%20register",
    );
  });

  it("says what a report leads to, in the copy's words", () => {
    const { container } = render(<OwnershipReportError subject="Ownership data: hub" />);
    expect(container.textContent).toBe(
      "Spotted a problem with a figure? Report an error and the affected notice will be read again against its PDF.",
    );
  });
});

describe("OwnershipSourceLines", () => {
  it("prints each source with its own date set as a time", () => {
    const { container } = render(
      <OwnershipSourceLines
        lines={[
          { text: "ASIC short position report, as of 2026-10-16, published T+4.", asAt: "2026-10-16" },
          { text: "Index fund holdings files, as at 2026-09-30." },
        ]}
      />,
    );
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toBe("ASIC short position report, as of 2026-10-16, published T+4.");
    expect(items[0]!.querySelector("time")).toHaveAttribute("datetime", "2026-10-16");
    // A date the line states is set as a time even when the caller names no as-at date.
    expect(items[1]!.querySelector("time")).toHaveAttribute("datetime", "2026-09-30");
    expect(items[1]!.querySelector("time")!.textContent).toBe("2026-09-30");
  });

  it("sets both dates of a range as times", () => {
    const { container } = render(
      <OwnershipSourceLines lines={[{ text: "Index fund holdings files, as at 2026-09-30 to 2026-10-19." }]} />,
    );
    const times = Array.from(container.querySelectorAll("li time"));
    expect(times.map((time) => time.getAttribute("datetime"))).toEqual(["2026-09-30", "2026-10-19"]);
  });

  it("wraps a whole line in a time when the line does not carry its date", () => {
    const { container } = render(<OwnershipSourceLines lines={[{ text: "Notices read", asAt: "2026-10-19" }]} />);
    const time = container.querySelector("li time");
    expect(time).toHaveAttribute("datetime", "2026-10-19");
    expect(time!.textContent).toBe("Notices read");
  });

  it("prints nothing for no sources", () => {
    const { container } = render(<OwnershipSourceLines lines={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
