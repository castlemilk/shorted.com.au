/// <reference types="jest" />

import { fireEvent, render, screen } from "@testing-library/react";
import { SelectionTray, type SelectionTrayProps } from "../selection-tray";

const ITEMS = [
  { key: "asx:A200", label: "A200" },
  { key: "asx:IOZ", label: "IOZ" },
];

function renderTray(overrides: Partial<SelectionTrayProps> = {}) {
  const onRemove = jest.fn();
  const props: SelectionTrayProps = {
    label: "Selected funds",
    items: ITEMS,
    max: 3,
    noun: ["fund", "funds"],
    onRemove,
    ...overrides,
  };
  render(<SelectionTray {...props} />);
  return onRemove;
}

describe("SelectionTray (spec 10.5)", () => {
  it("draws nothing when no item is selected", () => {
    renderTray({ items: [] });
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("names the region and counts the items with the plural noun", () => {
    renderTray();
    expect(screen.getByRole("region", { name: "Selected funds" })).toBeInTheDocument();
    expect(screen.getByText(/^2 funds selected$/)).toBeInTheDocument();
  });

  it("uses the singular noun for one item", () => {
    renderTray({ items: [ITEMS[0]!] });
    expect(screen.getByText(/^1 fund selected$/)).toBeInTheDocument();
  });

  it("removes the item whose chip is pressed, by its key", () => {
    const onRemove = renderTray();
    fireEvent.click(screen.getByRole("button", { name: "Remove IOZ" }));
    expect(onRemove).toHaveBeenCalledWith("asx:IOZ");
  });

  it("draws the note and the call to action after the chips", () => {
    renderTray({
      note: <p>The comparison reads one fund.</p>,
      cta: <a href="/next">Continue</a>,
    });
    const region = screen.getByRole("region", { name: "Selected funds" });
    expect(region).toHaveTextContent("The comparison reads one fund.");
    expect(screen.getByRole("link", { name: "Continue" })).toHaveAttribute("href", "/next");
  });

  it("flags a selection past its limit in development, and not at the limit", () => {
    const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
    try {
      renderTray({ max: 2 });
      expect(warn).not.toHaveBeenCalled();
      renderTray({ max: 1 });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("past its limit of 1"));
    } finally {
      warn.mockRestore();
    }
  });
});
