/// <reference types="jest" />

/**
 * The in-place expander (spec 14.9): a chevron button in the row's first cell carries
 * aria-expanded, and the detail is drawn under the row, closed at first.
 */

import { fireEvent, render, screen } from "@testing-library/react";
import { ExpandableRow } from "../expandable-row";

function renderRow() {
  return render(
    <table>
      <tbody>
        <ExpandableRow
          id="holding-BHP"
          label="BHP details"
          colSpan={3}
          detail={<p>Value (AUD) 1,000</p>}
        >
          <td>BHP</td>
          <td>BHP Group</td>
        </ExpandableRow>
      </tbody>
    </table>,
  );
}

describe("ExpandableRow", () => {
  it("draws a closed chevron button with aria-expanded=false and no detail in the document", () => {
    renderRow();
    const button = screen.getByRole("button", { name: "Show BHP details" });
    expect(button).toHaveAttribute("aria-expanded", "false");
    // The detail is not in the document while closed, so the button names nothing (no dangling reference).
    expect(button).not.toHaveAttribute("aria-controls");
    expect(screen.queryByText("Value (AUD) 1,000")).toBeNull();
  });

  it("names the detail it controls once it is open", () => {
    renderRow();
    fireEvent.click(screen.getByRole("button", { name: "Show BHP details" }));
    expect(screen.getByRole("button", { name: "Hide BHP details" })).toHaveAttribute("aria-controls", "holding-BHP");
  });

  it("opens the detail under the row in place, and closes it again", () => {
    const { container } = renderRow();
    const button = screen.getByRole("button", { name: "Show BHP details" });
    fireEvent.click(button);
    expect(screen.getByRole("button", { name: "Hide BHP details" })).toHaveAttribute("aria-expanded", "true");
    const detail = container.querySelector("tr#holding-BHP td");
    expect(detail).toHaveAttribute("colspan", "3");
    expect(detail).toHaveTextContent("Value (AUD) 1,000");
    fireEvent.click(screen.getByRole("button", { name: "Hide BHP details" }));
    expect(screen.getByRole("button", { name: "Show BHP details" })).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("tr#holding-BHP")).toBeNull();
  });

  it("puts the chevron in the first cell, before the data", () => {
    const { container } = renderRow();
    const firstCell = container.querySelector("tbody tr > td");
    expect(firstCell?.querySelector("button")).not.toBeNull();
  });
});
