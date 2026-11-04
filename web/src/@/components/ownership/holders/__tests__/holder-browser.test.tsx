/// <reference types="jest" />

import { fireEvent, render, screen, within } from "@testing-library/react";
import { HolderBrowser } from "../holder-browser";
import type { HolderRow } from "../holder-tree";

jest.mock("~/@/components/gamma/SearchCombobox", () => ({
  SearchCombobox: ({ options, onValueChange, placeholder, ...rest }: {
    options: Array<{ value: string; label: string }>;
    onValueChange?: (value: string | null) => void;
    placeholder?: string;
    "aria-label"?: string;
  }) => (
    <select aria-label={rest["aria-label"]} defaultValue="" onChange={(e) => onValueChange?.(e.target.value || null)}>
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  ),
}));
let mockSearch = "";
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  usePathname: () => "/ownership/holders",
  useRouter: () => ({ prefetch: jest.fn(), replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const holders: HolderRow[] = [
  { key: "vanguard", name: "Vanguard", kind: "index_manager", website: "", positions: 157, latestNoticeDate: "2026-11-02" },
  { key: "aus-super", name: "AustralianSuper", kind: "super_fund", website: "", positions: 60, latestNoticeDate: "2026-10-30" },
  { key: "regal", name: "Regal Partners", kind: "active_manager", website: "", positions: 20, latestNoticeDate: "2026-10-20" },
];

describe("holder browser (spec 14.3)", () => {
  beforeEach(() => {
    mockSearch = "";
    mockReplace.mockClear();
  });

  it("lists the directory, marks the default holder, and names each row's disclosed positions", () => {
    render(<HolderBrowser holders={holders} defaultKey="vanguard" />);
    const list = screen.getByRole("list", { name: "Holders" });
    const rows = within(list).getAllByRole("button");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(rows[0]).toHaveTextContent("Vanguard");
    expect(rows[0]).toHaveTextContent("157");
    expect(rows[0]).toHaveTextContent(/\d+ disclosed positions/);
  });

  it("spans the find box, the kind chips and the status line above the columns, with the map beside the list", () => {
    render(
      <HolderBrowser holders={holders} defaultKey="vanguard">
        <section aria-label="Connections map">Map</section>
      </HolderBrowser>,
    );
    const status = screen.getByText("Substantial notices · Latest reported interest per holder");
    const heading = screen.getByRole("heading", { name: "Browse holders" });
    const map = screen.getByRole("region", { name: "Connections map" });
    expect(status.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(map) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Holders" })).getAllByRole("button")).toHaveLength(3);
  });

  it("writes the picked holder into the URL and clears the company selection", () => {
    mockSearch = "sel=stock%3ABHP";
    render(<HolderBrowser holders={holders} defaultKey="vanguard" />);
    fireEvent.click(within(screen.getByRole("list", { name: "Holders" })).getByRole("button", { name: /Regal Partners/ }));
    expect(mockReplace).toHaveBeenCalledWith("/ownership/holders?holder=regal", { scroll: false });
  });

  it("shows the holder the URL names, when the register lists it", () => {
    mockSearch = "holder=aus-super";
    render(<HolderBrowser holders={holders} defaultKey="vanguard" />);
    const active = within(screen.getByRole("list", { name: "Holders" })).getByRole("button", { pressed: true });
    expect(active).toHaveTextContent("AustralianSuper");
  });

  it("shows the default holder for a value that is not a slug, as the map and the inspector do", () => {
    mockSearch = "holder=asx:BHP";
    render(<HolderBrowser holders={holders} defaultKey="vanguard" />);
    expect(within(screen.getByRole("list", { name: "Holders" })).getByRole("button", { pressed: true })).toHaveTextContent(
      "Vanguard",
    );
  });

  it("highlights no row for a slug the register does not list, where the map reports it could not be read", () => {
    mockSearch = "holder=nobody-here";
    render(<HolderBrowser holders={holders} defaultKey="vanguard" />);
    expect(within(screen.getByRole("list", { name: "Holders" })).queryByRole("button", { pressed: true })).toBeNull();
  });

  it("filters the list by a kind chip, and says when none matches", () => {
    render(<HolderBrowser holders={holders} defaultKey="vanguard" />);
    fireEvent.click(screen.getByRole("radio", { name: "Super funds" }));
    const list = screen.getByRole("list", { name: "Holders" });
    expect(within(list).getAllByRole("button")).toHaveLength(1);
    expect(within(list).getByText("AustralianSuper")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Hedge funds" }));
    expect(screen.getByText("No holder matches these filters.")).toBeInTheDocument();
  });
});
