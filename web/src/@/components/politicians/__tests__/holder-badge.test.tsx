/**
 * A row with no holder must SAY so.
 *
 * 2,279 published rows carry RegisterHolder.UNSPECIFIED, almost all from the
 * 46th and 47th Parliament alteration forms, whose two-column "Item | Details"
 * layout has no holder column at all. HolderBadge returned null for them, so
 * they sat unchipped beside rows chipped "Self", under the member's own name
 * and a heading reading "Declared company interests".
 *
 * A reader has no way to tell "we know this is the member's" from "the form
 * never said". Rendering nothing lets the page imply the first.
 */

import { render, screen } from "@testing-library/react";

import { HolderBadge } from "../compliance";
import { RegisterHolder } from "~/gen/shorts/v1alpha1/politicians_pb";

describe("HolderBadge", () => {
  it.each([
    [RegisterHolder.SELF, "Self"],
    [RegisterHolder.SPOUSE_PARTNER, "Spouse/partner"],
    [RegisterHolder.DEPENDENT_CHILDREN, "Dependent child"],
    [RegisterHolder.UNSPECIFIED, "Holder not stated"],
  ])("labels holder %s as %s", (holder, label) => {
    render(<HolderBadge holder={holder} />);
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("never infers a holder the form did not record", () => {
    render(<HolderBadge holder={RegisterHolder.UNSPECIFIED} />);
    const badge = screen.getByText("Holder not stated");
    expect(badge.textContent).not.toMatch(/\bself\b|\bspouse\b|\bchild/i);
    // The title must not claim this is a property of ALTERATION forms in
    // general: 1,021 of 1,022 48th-Parliament alteration rows ARE attributed.
    expect(badge.getAttribute("title") ?? "").not.toMatch(/alteration/i);
  });

  it("states no quantity, value or currency", () => {
    render(<HolderBadge holder={RegisterHolder.UNSPECIFIED} />);
    expect(screen.getByText("Holder not stated").textContent ?? "").not.toMatch(
      /[$€£]|\bworth\b|\bvalued\b/i,
    );
  });
});
