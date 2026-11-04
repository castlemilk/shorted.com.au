/// <reference types="jest" />

import { render, screen, within } from "@testing-library/react";
import { Inspector } from "../inspector";
import type { LargestMovesBlock } from "../inspector-types";

let mockSearch = "";
jest.mock("next/navigation", () => ({
  usePathname: () => "/ownership/activity",
  useRouter: () => ({ prefetch: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const BLOCK: LargestMovesBlock = {
  windowDays: 91,
  from: "2026-08-03",
  to: "2026-11-01",
  lines: [
    { label: "BHP · Vanguard", value: "+1.20 pp · 2026-10-28", href: "https://www.asx.com.au/bhp.pdf" },
    { label: "RIO · BlackRock", value: "−2.50 pp · 2026-10-20", href: "" },
  ],
};

beforeEach(() => {
  mockSearch = "";
});

describe("the Activity rail's empty state: largest moves (spec 14.10)", () => {
  it("lists the window's largest moves under the prompt, each with its change and its notice", () => {
    render(<Inspector resolve={jest.fn(async () => null)} emptyText="Select a cell to inspect the notices behind it." largestMoves={BLOCK} />);
    const heading = screen.getByRole("heading", { name: "Largest moves, every holder type, last 91 days" });
    const section = heading.closest("section") as HTMLElement;
    expect(within(section).getAllByRole("listitem")).toHaveLength(2);
    expect(within(section).getByText("+1.20 pp · 2026-10-28")).toBeInTheDocument();
    const link = within(section).getByRole("link", { name: "BHP · Vanguard" });
    expect(link).toHaveAttribute("href", "https://www.asx.com.au/bhp.pdf");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("draws a move whose notice is not a safe link as text, never as a link", () => {
    render(<Inspector resolve={jest.fn(async () => null)} emptyText="Select a cell." largestMoves={BLOCK} />);
    expect(screen.getByText("RIO · BlackRock")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "RIO · BlackRock" })).toBeNull();
  });

  it("says no notice states a change, rather than drawing an empty list, when the window has none", () => {
    render(
      <Inspector resolve={jest.fn(async () => null)} emptyText="Select a cell." largestMoves={{ windowDays: 91, from: "2026-08-03", to: "2026-11-01", lines: [] }} />,
    );
    expect(screen.getByText("No notice from 2026-08-03 to 2026-11-01 states a change.")).toBeInTheDocument();
  });

  it("names the window's dates above the list, so a visitor reads the span the ranking covers", () => {
    render(<Inspector resolve={jest.fn(async () => null)} emptyText="Select a cell." largestMoves={BLOCK} />);
    expect(screen.getByRole("heading", { name: "Largest moves, every holder type, last 91 days" })).toBeInTheDocument();
    expect(screen.getByText("Notices released 2026-08-03 to 2026-11-01")).toBeInTheDocument();
  });

  it("draws the prompt alone when the page has no moves to list", () => {
    render(<Inspector resolve={jest.fn(async () => null)} emptyText="Select a company." />);
    expect(screen.getByText("Select a company.")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Largest moves, every holder type, last 91 days" })).toBeNull();
  });

  it("does not list the moves once a selection is made", () => {
    mockSearch = "sel=stock%3ABHP";
    render(<Inspector resolve={jest.fn(async () => null)} emptyText="Select a cell." largestMoves={BLOCK} />);
    expect(screen.queryByRole("heading", { name: "Largest moves, every holder type, last 91 days" })).toBeNull();
  });
});
