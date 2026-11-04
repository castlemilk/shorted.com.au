import fs from "fs";
import path from "path";
import React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import { MainNav, isActivePath } from "../main-nav";
import type { NavItemWithGroup } from "../site-header";

// The pathname and the session are read through mutable variables so each case
// can set them. The factories read them lazily, at render time.
let mockPathname = "/";
let mockSessionData: { user: { name: string } } | null = null;
const mockPush = jest.fn();

jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useRouter: () => ({
    push: mockPush,
    replace: jest.fn(),
    back: jest.fn(),
    forward: jest.fn(),
    refresh: jest.fn(),
    prefetch: jest.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

// The real account menu pulls in the Radix dropdown, which does not load under
// this Jest setup. The assertions here are about MainNav's own markup.
jest.mock("~/@/components/ui/user-auth-nav", () => ({
  UserAuthNav: () => null,
}));

jest.mock("next-auth/react", () => ({
  useSession: () => ({
    data: mockSessionData,
    status: mockSessionData ? "authenticated" : "unauthenticated",
    update: jest.fn(),
  }),
  signIn: jest.fn(),
  signOut: jest.fn(),
}));

// The shape of site-header.tsx's list: two primary items, one locked primary
// item (signed out it is locked), and two secondary items behind "More".
const items: NavItemWithGroup[] = [
  { title: "housing", href: "/housing", primary: true },
  { title: "screener", href: "/screener", primary: true },
  {
    title: "industry intel",
    href: "/industry-intelligence",
    primary: true,
    requiresAuth: true,
  },
  { title: "ownership", href: "/ownership" },
  { title: "reports", href: "/reports" },
];

// The class attribute, not `className`: on an SVG element that is an object.
const classesOf = (el: Element) =>
  (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

const link = (name: string) => screen.getByRole("link", { name });
const moreTrigger = () => screen.getByRole("button", { name: /More/ });

describe("isActivePath", () => {
  it.each([
    ["/ownership/map", "/ownership", true],
    ["/ownership", "/ownership", true],
    ["/reports/weekly/2026-W40", "/reports", true],
    ["/ownershipx", "/ownership", false],
    ["/", "/", true],
    ["/top", "/", false],
    ["/housing", "/", false],
    // Every path starts with "", so without the guard this would be true.
    ["/top", "", false],
    ["/", "", false],
  ])("isActivePath(%j, %j) is %s", (pathname, href, expected) => {
    expect(isActivePath(pathname, href)).toBe(expected);
  });
});

describe("MainNav active grammar", () => {
  beforeEach(() => {
    mockPathname = "/";
    mockSessionData = null;
  });

  it("lights More with an amber underline, not a fill, inside an ownership page", () => {
    mockPathname = "/ownership/map";
    render(<MainNav items={items} />);

    const classes = classesOf(moreTrigger());
    expect(classes).toEqual(expect.arrayContaining(["text-primary", "border-primary"]));
    expect(classes).not.toContain("bg-secondary");
  });

  it("underlines the housing link on /housing/vic and leaves the screener idle", () => {
    mockPathname = "/housing/vic";
    render(<MainNav items={items} />);

    expect(link("housing")).toHaveClass("border-primary");
    expect(link("housing")).toHaveClass("text-primary");

    const screener = link("screener");
    expect(screener).toHaveClass("border-transparent");
    expect(classesOf(screener)).not.toContain("border-primary");
  });

  it("keeps the idle border so the box does not change height on activation", () => {
    mockPathname = "/housing";
    render(<MainNav items={items} />);

    expect(link("housing")).toHaveClass("border-b-2");
    expect(link("screener")).toHaveClass("border-b-2");
    expect(moreTrigger()).toHaveClass("border-b-2");
  });

  it("underlines the open secondary item inside the More popover", async () => {
    mockPathname = "/reports/weekly/2026-W40";
    render(<MainNav items={items} />);

    await userEvent.click(moreTrigger());

    const reportsLabel = screen.getByText("reports");
    expect(reportsLabel).toHaveClass("border-primary");
    expect(reportsLabel).toHaveClass("text-primary");

    const ownershipLabel = screen.getByText("ownership");
    expect(ownershipLabel).toHaveClass("border-transparent");
    expect(classesOf(ownershipLabel)).not.toContain("border-primary");

    // The popover row keeps its rounded-lg and carries no fill when active.
    const reportsRow = reportsLabel.closest("a");
    expect(reportsRow).not.toBeNull();
    expect(classesOf(reportsRow!)).toContain("rounded-lg");
    expect(classesOf(reportsRow!)).not.toContain("bg-secondary");
  });

  it("does not light More for a secondary item with an empty href", () => {
    mockPathname = "/top";
    render(
      <MainNav
        items={[
          { title: "housing", href: "/housing", primary: true },
          { title: "blank", href: "" },
        ]}
      />
    );

    expect(moreTrigger()).toHaveClass("border-transparent");
    expect(classesOf(moreTrigger())).not.toContain("border-primary");
  });

  it("marks the current page with aria-current and no other item", async () => {
    mockPathname = "/housing/vic";
    const { unmount } = render(<MainNav items={items} />);

    expect(link("housing")).toHaveAttribute("aria-current", "page");
    expect(link("screener")).not.toHaveAttribute("aria-current");
    unmount();

    mockPathname = "/reports/weekly/2026-W40";
    render(<MainNav items={items} />);
    await userEvent.click(moreTrigger());

    expect(screen.getByText("reports").closest("a")).toHaveAttribute(
      "aria-current",
      "page"
    );
    expect(screen.getByText("ownership").closest("a")).not.toHaveAttribute(
      "aria-current"
    );
  });

  it("keeps a locked item muted, even on its own page, and never underlines it", () => {
    mockPathname = "/industry-intelligence";
    mockSessionData = null;
    render(<MainNav items={items} />);

    const locked = link("industry intel");
    expect(locked).toHaveClass("text-muted-foreground");
    expect(locked).not.toHaveClass("text-primary");
    expect(classesOf(locked)).not.toContain("border-primary");
  });
});

describe("MainNav paints no fill at rest", () => {
  beforeEach(() => {
    mockPathname = "/ownership/map";
    mockSessionData = { user: { name: "Test User" } };
  });

  it("has no bg-secondary class in the markup", () => {
    const { container } = render(<MainNav items={items} />);

    expect(container.innerHTML).not.toMatch(/(^|[\s"])bg-secondary([\s"]|$)/);
  });

  it("pairs every hover:bg-secondary/50 with the dark muted hover", () => {
    render(<MainNav items={items} />);

    const hovered = Array.from(document.body.querySelectorAll("[class]")).filter(
      (el) => classesOf(el).includes("hover:bg-secondary/50")
    );
    expect(hovered.length).toBeGreaterThan(0);
    for (const el of hovered) {
      expect(classesOf(el)).toContain("dark:hover:bg-muted");
    }
  });
});

describe("main-nav and mobile-nav class strings", () => {
  const readSource = (name: string) =>
    fs.readFileSync(path.join(__dirname, "..", name), "utf8");
  const sources = {
    "main-nav.tsx": readSource("main-nav.tsx"),
    "mobile-nav.tsx": readSource("mobile-nav.tsx"),
  };

  it("paints bg-secondary or text-secondary only as hover:bg-secondary/50", () => {
    for (const [name, source] of Object.entries(sources)) {
      const tokens = source.match(/[^\s"'`{}]*(?:bg|text)-secondary[^\s"'`{}]*/g) ?? [];
      for (const token of tokens) {
        expect({ file: name, token }).toEqual({ file: name, token: "hover:bg-secondary/50" });
      }
    }
  });

  it("puts the dark muted hover on every line that hovers to the secondary tint", () => {
    for (const [name, source] of Object.entries(sources)) {
      const lines = source.split("\n").filter((line) => line.includes("hover:bg-secondary/50"));
      for (const line of lines) {
        expect({ file: name, line: line.includes("dark:hover:bg-muted") }).toEqual({
          file: name,
          line: true,
        });
      }
    }
  });
});
