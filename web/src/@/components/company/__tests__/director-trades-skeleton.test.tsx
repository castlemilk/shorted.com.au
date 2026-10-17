import fs from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { DirectorTradesSkeleton } from "../director-trades-skeleton";

describe("DirectorTradesSkeleton", () => {
  it("is the director trades card: its title, then five full-width h-10 rows", () => {
    const { container } = render(<DirectorTradesSkeleton />);
    expect(
      screen.getByRole("heading", { level: 3, name: "Director trades" }),
    ).toBeInTheDocument();
    const rows = Array.from(container.querySelectorAll(".animate-pulse"));
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).toHaveClass("h-10", "w-full");
    // Stacked with the table card's own 8px gap.
    expect(rows[0]!.parentElement).toHaveClass("space-y-2");
    expect(rows.every((row) => row.parentElement === rows[0]!.parentElement)).toBe(true);
  });

  // The shared jest setup stubs Card with a bare div, so only the classes the
  // skeleton passes in are visible here: the loaded card's title row.
  it("has the title row the loaded card has", () => {
    render(<DirectorTradesSkeleton />);
    const title = screen.getByRole("heading", { level: 3 });
    expect(title).toHaveClass("text-lg", "flex", "items-center", "gap-2");
    expect(title.parentElement).toHaveClass("pb-3");
  });

  it("says nothing but its title: the rows are blank bones", () => {
    const { container } = render(<DirectorTradesSkeleton />);
    expect(container.textContent).toBe("Director trades");
  });
});

// The Company page is a server component and imports this to hand next/dynamic
// as the island's `loading`. It may not become a client module, and may not pull
// Connect-RPC into a server bundle: the table it stands in for is the island
// that does (CLAUDE.md, "SSR Issues with @connectrpc/connect").
describe("director-trades-skeleton.tsx is server-safe", () => {
  const source = fs.readFileSync(path.join(__dirname, "../director-trades-skeleton.tsx"), "utf8");
  const importSpecifiers = Array.from(
    source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm),
    (m) => m[1],
  );

  it('has no "use client" directive', () => {
    expect(source).not.toMatch(/^\s*["']use client["']/m);
  });

  it("imports nothing from Connect, the generated clients or the island it stands in for", () => {
    expect(importSpecifiers.length).toBeGreaterThan(0);
    for (const specifier of importSpecifiers) {
      expect(specifier).not.toMatch(/connectrpc|bufbuild|~\/gen\/|director-trades-table|actions\/client\//);
    }
  });
});
