/// <reference types="jest" />

import { fireEvent, render, screen, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { DIRECTORY_FIRST, HolderBrowser, chipFromUrl, directoryRows, type DirectoryHolder } from "../holder-browser";
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
/** Set while a test renders the server's default view: the URL read suspends, as it does on the server. */
let mockSuspend = false;
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  usePathname: () => "/ownership/holders",
  useRouter: () => ({ prefetch: jest.fn(), replace: mockReplace }),
  useSearchParams: () => {
    if (mockSuspend) throw new Promise(() => undefined);
    return new URLSearchParams(mockSearch);
  },
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


describe("holder browser bars (spec 13.1, backlog A2)", () => {
  beforeEach(() => {
    mockSearch = "";
  });

  it("draws every holder's bar in the ramp's fourth stop, so the one legend teaches it", () => {
    // React writes the inline style itself, so the server markup shows each bar's stop as written.
    const markup = renderToStaticMarkup(<HolderBrowser holders={holders} defaultKey="vanguard" />);
    const bars = markup.match(/style="width:[^"]*;background:hsl\(var\(--desk-bin-3\)\)"/g) ?? [];
    expect(bars).toHaveLength(3);
    // The bar is the holder's share of the largest holder: Vanguard's 157 is the full width.
    expect(bars[0]).toContain("width:100%");
  });
});

/** The directory with what each holder gained in the window: ties on gains fall to positions. */
const ranked: DirectoryHolder[] = [
  { key: "vanguard", name: "Vanguard", kind: "index_manager", website: "", positions: 157, latestNoticeDate: "2026-11-02", positionsGained: 2 },
  { key: "aus-super", name: "AustralianSuper", kind: "super_fund", website: "", positions: 60, latestNoticeDate: "2026-10-30", positionsGained: 9 },
  { key: "regal", name: "Regal Partners", kind: "active_manager", website: "", positions: 20, latestNoticeDate: "2026-10-20", positionsGained: 9 },
  { key: "quiet", name: "Quiet Capital", kind: "hedge_fund", website: "", positions: 4, latestNoticeDate: "2026-09-01", positionsGained: 0 },
];

/** The row buttons of the directory, in the order they are drawn. */
function directoryNames(): string[] {
  return within(screen.getByRole("list", { name: "Holders" }))
    .getAllByRole("button")
    .map((row) => row.textContent ?? "");
}

describe("holder directory's rank (backlog C3b)", () => {
  it("ranks the directory by positions under Largest, as the server did", () => {
    expect(directoryRows(ranked, "all", "", false, "largest").rows.map((h) => h.key)).toEqual([
      "vanguard",
      "aus-super",
      "regal",
      "quiet",
    ]);
  });

  it("ranks by positions gained under Changed, ties by positions, and keeps a holder with none in the list", () => {
    expect(directoryRows(ranked, "all", "", false, "changed").rows.map((h) => h.key)).toEqual([
      "aus-super",
      "regal",
      "vanguard",
      "quiet",
    ]);
  });

  it("reads a row without a gained count as none, never as a figure", () => {
    const unknown: DirectoryHolder[] = [
      { key: "a", name: "Alpha", kind: "hedge_fund", website: "", positions: 5, latestNoticeDate: "" },
      { key: "b", name: "Beta", kind: "hedge_fund", website: "", positions: 3, latestNoticeDate: "", positionsGained: 1 },
    ];
    expect(directoryRows(unknown, "all", "", false, "changed").rows.map((h) => h.key)).toEqual(["b", "a"]);
  });

  it("keeps the twenty-row shortlist under Changed, and opens it for Show all", () => {
    const many: DirectoryHolder[] = Array.from({ length: DIRECTORY_FIRST + 5 }, (_, i) => ({
      key: `h${i}`,
      name: `Holder ${i}`,
      kind: "hedge_fund",
      website: "",
      positions: 100 - i,
      latestNoticeDate: "",
      positionsGained: i,
    }));
    const shortlist = directoryRows(many, "all", "", false, "changed");
    expect(shortlist.rows).toHaveLength(DIRECTORY_FIRST);
    expect(shortlist.rows[0]?.key).toBe(`h${DIRECTORY_FIRST + 4}`);
    expect(shortlist.total).toBe(DIRECTORY_FIRST + 5);
    expect(directoryRows(many, "all", "", true, "changed").rows).toHaveLength(DIRECTORY_FIRST + 5);
  });
});

describe("holder browser's sort (backlog C3b)", () => {
  beforeEach(() => {
    mockSearch = "";
    mockReplace.mockClear();
    window.history.replaceState(null, "", "/ownership/holders");
  });

  it("orders the rows and draws the bar and value of positions gained under Changed", () => {
    mockSearch = "sort=changed";
    render(<HolderBrowser holders={ranked} defaultKey="vanguard" />);
    expect(directoryNames()[0]).toContain("AustralianSuper");
    const row = within(screen.getByRole("list", { name: "Holders" })).getByRole("button", { name: /AustralianSuper/ });
    expect(row).toHaveTextContent("9 gained");
    expect(row.querySelector('[title="60 disclosed positions"]')).not.toBeNull();
    // Vanguard gained 2 of the largest 9: its bar is 22.2% of the full width.
    const vanguard = within(screen.getByRole("list", { name: "Holders" })).getByRole("button", { name: /Vanguard/ });
    expect(vanguard.innerHTML).toMatch(/width: 22\.2%/);
    expect(row.innerHTML).toMatch(/width: 100%/);
  });

  it("keeps the disclosed positions and their bar under Largest", () => {
    render(<HolderBrowser holders={ranked} defaultKey="vanguard" />);
    expect(directoryNames()[0]).toContain("Vanguard");
    const vanguard = within(screen.getByRole("list", { name: "Holders" })).getByRole("button", { name: /Vanguard/ });
    expect(vanguard).toHaveTextContent("157");
    expect(vanguard).not.toHaveTextContent("gained");
  });

  it("draws the Sort select in the toolbar's one row, showing the sort the URL names", () => {
    mockSearch = "sort=changed";
    const { container } = render(<HolderBrowser holders={ranked} defaultKey="vanguard" />);
    const toolbars = container.querySelectorAll("[data-toolbar]");
    expect(toolbars).toHaveLength(1);
    const row = toolbars[0] as HTMLElement;
    const select = screen.getByRole("combobox", { name: "Sort" }) as HTMLSelectElement;
    expect(select.value).toBe("changed");
    // The Sort control's label is itself a child of the row, not nested in a wrapper under it.
    expect(select.closest("label")?.parentElement).toBe(row);
    // It comes after the kind chips, so the row reads find, chips, sort.
    const chips = screen.getByRole("radiogroup", { name: "Holder kind" });
    expect(chips.compareDocumentPosition(select) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(row.contains(chips)).toBe(true);
  });

  it("writes the sort into the link in place, keeping the holder", () => {
    mockSearch = "holder=aus-super";
    window.history.replaceState(null, "", "/ownership/holders?holder=aus-super");
    render(<HolderBrowser holders={ranked} defaultKey="vanguard" />);
    fireEvent.change(screen.getByRole("combobox", { name: "Sort" }), { target: { value: "changed" } });
    expect(window.location.search).toBe("?holder=aus-super&sort=changed");
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("names the shortlist's order in its collapse button under Changed", () => {
    const many: DirectoryHolder[] = Array.from({ length: DIRECTORY_FIRST + 5 }, (_, i) => ({
      key: `h${i}`,
      name: `Holder ${i}`,
      kind: "hedge_fund",
      website: "",
      positions: 100 - i,
      latestNoticeDate: "",
      positionsGained: i,
    }));
    mockSearch = "sort=changed";
    render(<HolderBrowser holders={many} defaultKey="h0" />);
    const toggle = screen.getByRole("button", { name: `Show all ${DIRECTORY_FIRST + 5} holders` });
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: `Show the first ${DIRECTORY_FIRST}` })).toBeInTheDocument();
    mockSearch = "";
  });

  it("draws the server's default view on Largest, with the Sort select disabled", () => {
    // The URL read suspends here, so the server renders the Suspense fallback: the default view.
    mockSearch = "sort=changed";
    mockSuspend = true;
    let markup: string;
    try {
      markup = renderToStaticMarkup(<HolderBrowser holders={ranked} defaultKey="vanguard" />);
    } finally {
      mockSuspend = false;
    }
    const host = document.createElement("div");
    host.innerHTML = markup;
    const select = Array.from(host.querySelectorAll("select")).find((el) => el.querySelector('option[value="changed"]'));
    expect(select?.value).toBe("largest");
    expect(select?.disabled).toBe(true);
  });
});

describe("holder browser's kind from the URL (backlog C3b)", () => {
  beforeEach(() => {
    mockSearch = "";
  });

  it("opens on the kind a flow's link names, so the link lands filtered", () => {
    mockSearch = "kind=super_fund";
    render(<HolderBrowser holders={ranked} defaultKey="vanguard" />);
    expect(screen.getByRole("radio", { name: "Super funds" })).toBeChecked();
    expect(directoryNames()).toHaveLength(1);
    expect(directoryNames()[0]).toContain("AustralianSuper");
  });

  it("opens on All holders for a kind that names no chip", () => {
    mockSearch = "kind=nonsense";
    render(<HolderBrowser holders={ranked} defaultKey="vanguard" />);
    expect(screen.getByRole("radio", { name: "All holders" })).toBeChecked();
    expect(directoryNames()).toHaveLength(ranked.length);
  });

  it("validates the URL's kind against the chips", () => {
    expect(chipFromUrl("super_fund")).toBe("super_fund");
    expect(chipFromUrl("other")).toBe("other");
    expect(chipFromUrl("asx:BHP")).toBe("all");
    expect(chipFromUrl(null)).toBe("all");
    expect(chipFromUrl(undefined)).toBe("all");
  });
});
