/// <reference types="jest" />

/**
 * The sort control (backlog C3): one labelled select in the toolbar, the two words the reader
 * sees, the disabled server view, the handler an island passes, and the in-place write that
 * keeps the rest of the link.
 */

import { fireEvent, render, screen } from "@testing-library/react";

import { SortControl, SORT_LABELS, writeSortInPlace } from "../sort-control";

function linkAt(search: string): void {
  window.history.replaceState(null, "", `/ownership/map${search}`);
}

describe("SortControl", () => {
  it("is one labelled select, named Sort, with the active sort selected", () => {
    render(<SortControl active="largest" onChange={() => undefined} />);
    const select = screen.getByRole("combobox", { name: "Sort" });
    expect(select).toHaveValue("largest");
    expect(screen.getByRole("option", { name: SORT_LABELS.largest })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: SORT_LABELS.changed })).toBeInTheDocument();
  });

  it("draws the select disabled on the server's default view, which has no handler", () => {
    render(<SortControl active="largest" />);
    expect(screen.getByRole("combobox", { name: "Sort" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("largest");
  });

  it("calls the handler with the chosen sort", () => {
    const onChange = jest.fn();
    render(<SortControl active="largest" onChange={onChange} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "changed" } });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("changed");
  });

  it("is enabled once a handler is passed, and shows the changed sort", () => {
    render(<SortControl active="changed" onChange={() => undefined} />);
    expect(screen.getByRole("combobox", { name: "Sort" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "Sort" })).toHaveValue("changed");
  });

  it("names the two sorts with the words the reader sees, and carries the link's values", () => {
    expect(SORT_LABELS).toEqual({ largest: "Largest", changed: "Changed" });
    render(<SortControl active="changed" />);
    expect(screen.getByRole("option", { name: "Largest" })).toHaveAttribute("value", "largest");
    expect(screen.getByRole("option", { name: "Changed" })).toHaveAttribute("value", "changed");
  });

  it("sits in a toolbar row as one label and one select, so it cannot wrap its own words", () => {
    const { container } = render(<SortControl active="largest" onChange={() => undefined} />);
    expect(container.querySelectorAll("select")).toHaveLength(1);
    expect(container.querySelector("label")).toHaveTextContent("Sort");
  });
});

describe("writeSortInPlace", () => {
  afterEach(() => linkAt(""));

  it("writes sort=changed into the link, keeping every other parameter", () => {
    linkAt("?window=28&lens=flow&utm=1");
    writeSortInPlace("changed");
    const params = new URLSearchParams(window.location.search);
    expect(params.get("sort")).toBe("changed");
    expect(params.get("window")).toBe("28");
    expect(params.get("lens")).toBe("flow");
    expect(params.get("utm")).toBe("1");
  });

  it("removes sort for the default, so the bare link is the default view", () => {
    linkAt("?sort=changed&sel=stock%3ABHP");
    writeSortInPlace("largest");
    expect(window.location.search).toBe("?sel=stock%3ABHP");
  });

  it("replaces the history entry rather than adding one", () => {
    linkAt("?lens=flow");
    const before = window.history.length;
    writeSortInPlace("changed");
    expect(window.history.length).toBe(before);
    expect(window.location.pathname).toBe("/ownership/map");
  });
});
