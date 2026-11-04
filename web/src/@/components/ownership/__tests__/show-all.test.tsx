import { render, screen, within } from "@testing-library/react";

import { ShowAll } from "../show-all";

const rows = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => <li key={from + i}>row {from + i}</li>);

describe("ShowAll", () => {
  it("draws its children alone, with no disclosure, when the list is within the limit", () => {
    const { container } = render(
      <ShowAll total={20} limit={20} rest={<ul>{rows(20, 20)}</ul>}>
        <ul>{rows(0, 20)}</ul>
      </ShowAll>,
    );

    expect(container.querySelector("details")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(20);
  });

  it("holds the rest of a longer list in a disclosure, in the HTML and out of view", () => {
    const { container } = render(
      <ShowAll total={23} limit={20} rest={<ul>{rows(20, 23)}</ul>}>
        <ul>{rows(0, 20)}</ul>
      </ShowAll>,
    );

    const details = container.querySelector("details")!;
    expect(details).not.toHaveAttribute("open");
    // The rest is in the markup even while the disclosure is closed, so the page's text carries it.
    expect(within(details).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "row 20",
      "row 21",
      "row 22",
    ]);
    expect(within(container.querySelector("ul")!).getAllByRole("listitem")).toHaveLength(20);
  });

  it("names the total in its summary, and the open wording beside it", () => {
    const { container } = render(
      <ShowAll total={23} limit={20} rest={<ul>{rows(20, 23)}</ul>}>
        <ul>{rows(0, 20)}</ul>
      </ShowAll>,
    );

    const summary = container.querySelector("summary")!;
    expect(summary).toHaveTextContent("Show all 23");
    expect(summary).toHaveTextContent("Showing all 23");
    // The closed and open wordings are one each: group-open decides which shows.
    const spans = Array.from(summary.querySelectorAll("span"));
    expect(spans.map((span) => span.textContent)).toEqual(["Show all 23", "Showing all 23"]);
    expect(spans[0]).toHaveClass("group-open:hidden");
    expect(spans[1]).toHaveClass("group-open:inline");
    expect(container.querySelector("details")).toHaveClass("group");
  });

  it("draws the disclosure for a list one row past the limit, and none at the limit", () => {
    const over = render(
      <ShowAll total={21} limit={20} rest={<ul>{rows(20, 21)}</ul>}>
        <ul>{rows(0, 20)}</ul>
      </ShowAll>,
    );
    expect(over.container.querySelector("details")).not.toBeNull();
    over.unmount();

    const at = render(
      <ShowAll total={20} limit={20} rest={null}>
        <ul>{rows(0, 20)}</ul>
      </ShowAll>,
    );
    expect(at.container.querySelector("details")).toBeNull();
  });
});
