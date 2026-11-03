import { render, screen } from "@testing-library/react";
import { WithheldBreakdown, type WithheldCount } from "../withheld-breakdown";

const labels = (container: HTMLElement) => Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent);

describe("WithheldBreakdown", () => {
  it("labels the six withholding outcomes with their copy, a zero included, and the two documents not withheld apart", () => {
    const outcomes: WithheldCount[] = [
      { outcome: "no_text", count: 4 },
      { outcome: "ambiguous_target", count: 2 },
      { outcome: "not_a_notice", count: 3 },
      { outcome: "fetch_error", count: 1 },
    ];
    const { container } = render(<WithheldBreakdown outcomes={outcomes} />);
    expect(labels(container)).toEqual([
      "no text layer (a scan)",
      "voting power not stated, or only in an annexure",
      "figures that do not reconcile",
      "company not identified",
      "holder not named",
      "votes do not fit the share count",
    ]);
    expect(screen.getByText("no text layer (a scan)").nextElementSibling).toHaveTextContent("4");
    expect(screen.getByText("holder not named").nextElementSibling).toHaveTextContent("0");
    expect(
      screen.getByText(
        "A further 3 documents were not substantial holding forms and 1 has not yet been downloaded; neither is a withheld notice.",
      ),
    ).toBeInTheDocument();
  });

  it("prints its raw name for an outcome it has no copy for, after the six", () => {
    const { container } = render(
      <WithheldBreakdown outcomes={[{ outcome: "mystery_reason", count: 2 }, { outcome: "no_holder", count: 5 }]} />,
    );
    expect(labels(container).slice(-1)).toEqual(["mystery_reason"]);
    expect(screen.getByText("mystery_reason").nextElementSibling).toHaveTextContent("2");
    expect(screen.queryByText("not_a_notice")).toBeNull();
  });

  it("agrees the apart sentence with a single document", () => {
    render(<WithheldBreakdown outcomes={[{ outcome: "not_a_notice", count: 1 }, { outcome: "fetch_error", count: 1 }]} />);
    expect(
      screen.getByText(
        "A further 1 document was not a substantial holding form and 1 has not yet been downloaded; neither is a withheld notice.",
      ),
    ).toBeInTheDocument();
  });

  it("sums repeated outcomes into one row", () => {
    const { container } = render(
      <WithheldBreakdown outcomes={[{ outcome: "no_text", count: 2 }, { outcome: "no_text", count: 3 }]} />,
    );
    expect(screen.getByText("no text layer (a scan)").nextElementSibling).toHaveTextContent("5");
    expect(labels(container).filter((l) => l === "no text layer (a scan)")).toHaveLength(1);
  });

  it("gives each of the eight outcomes its own count beside its own label, and the two apart ones in the sentence", () => {
    const outcomes: WithheldCount[] = [
      "no_text",
      "no_voting_power",
      "implausible",
      "ambiguous_target",
      "no_holder",
      "inconsistent_votes",
      "not_a_notice",
      "fetch_error",
    ].map((outcome, index) => ({ outcome, count: index + 1 }));
    const { container } = render(<WithheldBreakdown outcomes={outcomes} />);
    expect(container.querySelectorAll("dt")).toHaveLength(6);

    const rows: Array<[label: string, count: string]> = [
      ["no text layer (a scan)", "1"],
      ["voting power not stated, or only in an annexure", "2"],
      ["figures that do not reconcile", "3"],
      ["company not identified", "4"],
      ["holder not named", "5"],
      ["votes do not fit the share count", "6"],
    ];
    for (const [label, count] of rows) {
      const dt = screen.getByText(label);
      const dd = dt.nextElementSibling;
      expect(dd?.tagName).toBe("DD");
      expect(dd?.textContent).toBe(count);
      expect(dd?.parentElement).toBe(dt.parentElement);
    }
    expect(
      screen.getByText(
        "A further 7 documents were not substantial holding forms and 8 have not yet been downloaded; neither is a withheld notice.",
      ),
    ).toBeInTheDocument();
  });

  it("leaves the apart sentence out when neither document is counted, and says only the half that is", () => {
    const { container, rerender } = render(<WithheldBreakdown outcomes={[{ outcome: "no_text", count: 1 }]} />);
    expect(container.querySelector("p")).toBeNull();

    rerender(<WithheldBreakdown outcomes={[{ outcome: "not_a_notice", count: 1 }]} />);
    expect(
      screen.getByText("A further 1 document was not a substantial holding form; it is not a withheld notice."),
    ).toBeInTheDocument();

    rerender(<WithheldBreakdown outcomes={[{ outcome: "fetch_error", count: 3 }]} />);
    expect(screen.getByText("A further 3 have not yet been downloaded; they are not withheld notices.")).toHaveClass(
      "tabular-nums",
    );
  });
});
