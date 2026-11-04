/// <reference types="jest" />

import { act, fireEvent, render, screen } from "@testing-library/react";
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

describe("WorkspaceSubNav", () => {
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

// A control the keyboard focuses under the stuck bar is scrolled clear of it (WCAG 2.2
// SC 2.4.11). jsdom has no layout, so the boxes are given: the bar sticks at 64px and is
// 45px tall, so a control is clear from 109 + 8 = 117px down.
describe("WorkspaceSubNav keeps focus clear of the bar it sticks", () => {
  const box = (top: number, height: number) =>
    ({ top, bottom: top + height, left: 0, right: 1280, width: 1280, height, x: 0, y: top }) as DOMRect;

  let scrollBy: jest.SpyInstance;
  let main: HTMLElement;

  beforeEach(() => {
    scrollBy = jest.spyOn(window, "scrollBy").mockImplementation(() => undefined);
    main = document.createElement("main");
    document.body.appendChild(main);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    main.remove();
  });

  // A link in the page's <main> at `top`, focused by the keyboard's own path (.focus()).
  const focusLinkAt = (top: number) => {
    const link = document.createElement("a");
    link.href = "#probe";
    main.appendChild(link);
    jest.spyOn(link, "getBoundingClientRect").mockReturnValue(box(top, 24));
    act(() => link.focus());
  };

  it("scrolls a control focused at 80px up until it sits 8px under the stuck bar", () => {
    render(<WorkspaceSubNav group="Group" tabs={TABS} activeTab="one" />);
    const nav = screen.getByRole("navigation", { name: "Group" });
    jest.spyOn(nav, "getBoundingClientRect").mockReturnValue(box(64, 45));
    focusLinkAt(80);
    expect(scrollBy).toHaveBeenCalledTimes(1);
    expect(scrollBy).toHaveBeenCalledWith({ top: 80 - (109 + 8) });
  });

  it("leaves a bar that does not stick alone, so a profile route keeps its own sticky bar", () => {
    render(<WorkspaceSubNav group="Group" tabs={TABS} activeTab="one" sticky={false} />);
    const nav = screen.getByRole("navigation", { name: "Group" });
    jest.spyOn(nav, "getBoundingClientRect").mockReturnValue(box(64, 45));
    focusLinkAt(80);
    expect(scrollBy).not.toHaveBeenCalled();
  });
});
