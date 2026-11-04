/// <reference types="jest" />

import { render } from "@testing-library/react";
import { WorkspacePage } from "../workspace-page";

describe("WorkspacePage (spec 14.1)", () => {
  it("lays the main column and the inspector out as a two-column grid from lg, with a 1 px rule", () => {
    const { container } = render(
      <WorkspacePage inspector={<p>Inspector body</p>}>
        <p>Main body</p>
      </WorkspacePage>,
    );
    const root = container.querySelector("[data-workspace]");
    expect(root).toHaveClass("lg:grid", "lg:grid-cols-[minmax(0,1fr)_320px]");
    const rail = root?.lastElementChild;
    expect(rail).toHaveClass("lg:border-l", "lg:border-border");
    expect(rail?.textContent).toBe("Inspector body");
    expect(root?.firstElementChild?.textContent).toBe("Main body");
  });

  it("draws no rail when a page passes no inspector", () => {
    const { container } = render(
      <WorkspacePage>
        <p>Main body</p>
      </WorkspacePage>,
    );
    const root = container.querySelector("[data-workspace]");
    expect(root?.children).toHaveLength(1);
    expect(container.querySelector(".lg\\:border-l")).toBeNull();
  });
});
