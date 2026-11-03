/// <reference types="jest" />
import "@testing-library/jest-dom";
import * as fs from "fs";
import * as path from "path";
import { render, screen } from "@testing-library/react";

/**
 * The ownership loading boundaries. A visitor who arrives while the register
 * renders sees its skeleton first. `aria-busy` and `aria-label` on a bare div are
 * not announced, so the skeleton is a live region: its root carries
 * `role="status"`, and the root must be that element, not a wrapper inside it.
 *
 * The boundaries are found on disk, so one added later under app/ownership is
 * held to the same rule without anyone editing this file.
 */

// The layout stands in as a div with a test id, not a passthrough: a skeleton that
// put the layout outside its status region would make the layout the root, and the
// root check below would catch it.
jest.mock("~/@/components/layouts/dashboard-layout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="dashboard-layout">{children}</div>
  ),
}));

const OWNERSHIP_DIR = path.resolve(__dirname, "..");
const REGISTER_LOADING = path.join(OWNERSHIP_DIR, "stocks", "[code]", "loading.tsx");
// The two static pages the explorer adds: the notice feed and the register list.
const NOTICES_LOADING = path.join(OWNERSHIP_DIR, "notices", "loading.tsx");
const REGISTERS_LOADING = path.join(OWNERSHIP_DIR, "stocks", "loading.tsx");
// The institution page: a segment's loading.tsx wraps it, so it has its own skeleton.
const INSTITUTION_LOADING = path.join(OWNERSHIP_DIR, "[slug]", "loading.tsx");

// eslint-disable-next-line @typescript-eslint/no-require-imports
const loadingAt = (file: string) => (require(file) as { default: () => React.ReactElement }).default;

function loadingFilesUnder(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : loadingFilesUnder(full);
    return entry.name === "loading.tsx" ? [full] : [];
  });
}

const files = loadingFilesUnder(OWNERSHIP_DIR).sort();

describe("the ownership loading boundaries", () => {
  it("has one for the register", () => {
    expect(files).toContain(REGISTER_LOADING);
  });

  it("has one for the notice feed and one for the register list", () => {
    expect(files).toEqual(expect.arrayContaining([NOTICES_LOADING, REGISTERS_LOADING]));
  });

  it("has one for the institution page, so the hub's desk skeleton never shows before it", () => {
    expect(files).toContain(INSTITUTION_LOADING);
  });

  it.each(files.map((file) => [path.relative(OWNERSHIP_DIR, file), file] as const))(
    "%s is a labelled status region that is busy, and is the root",
    (_name, file) => {
      const Loading = loadingAt(file);
      const { container } = render(<Loading />);
      const status = screen.getByRole("status");
      expect(container.firstElementChild).toBe(status);
      expect(status).toHaveAttribute("aria-busy", "true");
      expect(status).toHaveAttribute("aria-label", "Loading");
    },
  );

  // A skeleton that draws in the page's layout keeps the sidebar where it is when a client
  // navigation lands on it. Each one that does is named here and held to it: a boundary that
  // does not draw the layout is not wrong for that reason.
  it.each([
    ["the register", REGISTER_LOADING],
    ["the notice feed", NOTICES_LOADING],
    ["the register list", REGISTERS_LOADING],
    ["the institution page", INSTITUTION_LOADING],
  ])("draws %s's skeleton inside the layout, so the sidebar stays put", (_name, file) => {
    const Loading = loadingAt(file);
    render(<Loading />);
    expect(screen.getByRole("status")).toContainElement(screen.getByTestId("dashboard-layout"));
  });
});
