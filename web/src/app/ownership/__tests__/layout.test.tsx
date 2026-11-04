/// <reference types="jest" />

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import OwnershipLayout from "../layout";

// The stylesheets are not run under jest (package.json maps no .css); the layout's
// contract is that they are imported, and the bridge's own test checks their tokens.
jest.mock("~/@/components/gamma/gamma-bridge.css", () => ({}));
jest.mock("~/@/components/gamma/gamma.css", () => ({}));
jest.mock("~/@/components/gamma/DataTable.css", () => ({}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/ownership/funds",
  useRouter: () => ({ prefetch: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

describe("ownership workspace layout", () => {
  it("draws the sub-navigation above the page, with the active page marked", () => {
    render(
      <OwnershipLayout>
        <p>Page body</p>
      </OwnershipLayout>,
    );
    const nav = screen.getByRole("navigation", { name: "Ownership" });
    const links = Array.from(nav.querySelectorAll("a")).map((a) => a.getAttribute("href"));
    expect(links).toEqual([
      "/ownership",
      "/ownership/map",
      "/ownership/connections",
      "/ownership/activity",
      "/ownership/funds",
      "/ownership/holders",
      "/ownership/changes",
    ]);
    expect(screen.getByRole("link", { name: "Funds" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("Page body")).toBeInTheDocument();
  });


  it("imports the two Gamma stylesheets once, in the layout source", () => {
    const source = readFileSync(join(__dirname, "..", "layout.tsx"), "utf8");
    expect(source.match(/import "~\/@\/components\/gamma\/gamma-bridge\.css";/g)).toHaveLength(1);
    expect(source.match(/import "~\/@\/components\/gamma\/gamma\.css";/g)).toHaveLength(1);
  });
});
