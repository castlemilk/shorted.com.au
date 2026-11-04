/// <reference types="jest" />

import { fireEvent, render, screen } from "@testing-library/react";
import { WorkspaceSubNav, type WorkspaceTab } from "../workspace-sub-nav";
import { OWNERSHIP_GROUP, OWNERSHIP_TABS, activeOwnershipTab } from "~/@/components/ownership/workspace/nav";
import { STRATEGIES_GROUP, STRATEGIES_TABS, activeStrategiesTab } from "~/@/lib/strategies/workspace-nav";

const prefetch = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch, push: jest.fn() }),
}));

const TABS: readonly WorkspaceTab<"one" | "two">[] = [
  { id: "one", label: "One", href: "/one" },
  { id: "two", label: "Two", href: "/two" },
];

describe("WorkspaceSubNav (spec 10.5)", () => {
  beforeEach(() => prefetch.mockClear());

  it("names the group and marks only the active tab as the current page", () => {
    render(<WorkspaceSubNav group="Group" tabs={TABS} activeTab="two" />);
    expect(screen.getByRole("navigation", { name: "Group" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Two" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "One" })).not.toHaveAttribute("aria-current");
  });

  it("sticks under the site header by default, and not on a profile route", () => {
    const { unmount } = render(<WorkspaceSubNav group="Group" tabs={TABS} activeTab="one" />);
    expect(screen.getByRole("navigation", { name: "Group" }).className).toContain("sticky top-16 z-30");
    unmount();
    render(<WorkspaceSubNav group="Group" tabs={TABS} activeTab="one" sticky={false} />);
    expect(screen.getByRole("navigation", { name: "Group" }).className).not.toContain("sticky");
  });

  it("prefetches an inactive tab once, on intent, and never the active one", () => {
    render(<WorkspaceSubNav group="Group" tabs={TABS} activeTab="one" />);
    const two = screen.getByRole("link", { name: "Two" });
    fireEvent.pointerEnter(two);
    fireEvent.focus(two);
    expect(prefetch).toHaveBeenCalledTimes(1);
    expect(prefetch).toHaveBeenCalledWith("/two");
    fireEvent.pointerEnter(screen.getByRole("link", { name: "One" }));
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("renders the ownership registry with its own active tab", () => {
    render(
      <WorkspaceSubNav group={OWNERSHIP_GROUP} tabs={OWNERSHIP_TABS} activeTab={activeOwnershipTab("/ownership/funds/A200")} />,
    );
    expect(screen.getByRole("navigation", { name: "Ownership" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Funds" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Market map" })).toHaveAttribute("href", "/ownership/map");
  });

  it("renders the strategies registry with its own active tab", () => {
    render(
      <WorkspaceSubNav
        group={STRATEGIES_GROUP}
        tabs={STRATEGIES_TABS.filter((tab) => tab.enabled)}
        activeTab={activeStrategiesTab("/strategies/canslim/signals")}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Strategies" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Signals" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Alerts" })).toBeNull();
  });
});
