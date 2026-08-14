/**
 * The declarations island on `/politicians/[slug]`.
 *
 * TWO THINGS ARE UNDER TEST AND ONLY ONE OF THEM IS THE FILTERING.
 *
 * The first is PROGRESSIVE ENHANCEMENT. This page is the SEO asset for a named
 * person, and the redesign replaced three server-rendered lists with one
 * interactive surface. That trade is only acceptable while every published row
 * is still in the first render — a crawler, a reader with JavaScript off and a
 * reader-mode extraction must all see the complete set. The first assertions
 * below are that contract: unfiltered by construction, every row present, no
 * pagination.
 *
 * The second is the editorial vocabulary. The island renders no register data of
 * its own (the rows arrive pre-rendered from the server), but its chrome sits
 * beside a named parliamentarian, so the empty state must be about the FILTER
 * and never about the member — an absence claim belongs to the CoverageNote,
 * which states which documents we have actually read.
 */

import { fireEvent, render, screen, within } from "@testing-library/react";

import {
  DeclarationsTable,
  type DeclarationRow,
} from "../profile/declarations-table";

function row(
  id: string,
  itemNo: number,
  categoryLabel: string,
  holderKey: string,
  holderLabel: string,
  text: string,
  sinceEpoch = 0,
): DeclarationRow {
  return {
    id,
    itemNo,
    categoryKey: String(itemNo),
    categoryLabel,
    holderKey,
    holderLabel,
    searchText: `${text} ${categoryLabel} ${holderLabel}`.toLowerCase(),
    entityText: text.toLowerCase(),
    sinceEpoch,
    entity: <span>{text}</span>,
    holder: <span>{holderLabel}</span>,
    period: <span>{sinceEpoch ? `since ${sinceEpoch}` : "Date not stated"}</span>,
    source: <a href="https://example.test">PDF</a>,
  };
}

const ROWS: DeclarationRow[] = [
  row("a", 1, "Shareholdings", "self", "Self", "BHP Group Limited", 300),
  row("b", 1, "Shareholdings", "spouse-partner", "Spouse/partner", "Woodside Energy", 100),
  row("c", 3, "Real estate", "self", "Self", "Residence, Coogee NSW", 200),
  row("d", 3, "Real estate", "dependent-child", "Dependent child", "Investment, Manly NSW"),
  row("e", 6, "Liability", "not-stated", "Holder not stated", "Mortgage with a bank", 400),
];

function renderTable(rows: DeclarationRow[] = ROWS) {
  return render(<DeclarationsTable rows={rows} />);
}

function visibleTexts(): string[] {
  // Data rows only: the header row carries columnheaders and a category group
  // row carries a th, so "has at least one cell" selects exactly the entries.
  const panel = screen.getByRole("tabpanel");
  return within(panel)
    .queryAllByRole("row")
    .filter((r) => within(r).queryAllByRole("cell").length > 0)
    .map((r) => within(r).queryAllByRole("cell")[0]?.textContent ?? "");
}

describe("profile declarations island", () => {
  it("renders every row on first paint, with no filter applied", () => {
    // THE CRAWLABILITY CONTRACT. If this ever fails, the profile has stopped
    // being a complete server-rendered document and the redesign has traded
    // away the thing the page exists for.
    renderTable();
    expect(visibleTexts()).toHaveLength(ROWS.length);
    for (const entry of ROWS) {
      expect(screen.getByText((entry.entity as { props: { children: string } }).props.children))
        .toBeInTheDocument();
    }
    expect(screen.getByRole("tab", { name: /All 5/ })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Showing 5 of 5 entries.");
  });

  it("offers one tab per declared category, each carrying its own count", () => {
    renderTable();
    // Register-item order, not alphabetical or frequency order: the tabs read
    // like the form does.
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["All 5", "Shareholdings 2", "Real estate 2", "Liability 1"]);
    // No tab for a category this member has never declared.
    expect(screen.queryByRole("tab", { name: /Gift/ })).toBeNull();
  });

  it("filters to one category and drops the redundant group heading", () => {
    renderTable();
    expect(screen.getByRole("heading", { name: /Shareholdings/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Real estate 2" }));

    expect(visibleTexts()).toHaveLength(2);
    expect(screen.getByText("Residence, Coogee NSW")).toBeInTheDocument();
    expect(screen.queryByText("BHP Group Limited")).toBeNull();
    // One visible group needs no heading — the selected tab is the heading.
    expect(screen.queryByRole("heading", { name: /Real estate/ })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Showing 2 of 5 entries.");
  });

  it("filters on text, over the member's own words", () => {
    renderTable();
    fireEvent.change(screen.getByLabelText(/Filter declarations by text/i), {
      target: { value: "woodside" },
    });
    expect(visibleTexts()).toEqual(["Woodside Energy"]);
  });

  it("filters by who the entry is declared for, using the register's own labels", () => {
    renderTable();
    // The button copy is HolderBadge's, verbatim — one vocabulary for one
    // register attribute.
    fireEvent.click(screen.getByRole("button", { name: /Spouse\/partner/ }));
    expect(visibleTexts()).toEqual(["Woodside Energy"]);
    expect(screen.getByRole("button", { name: /Spouse\/partner/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("combines the filters and clears them all at once", () => {
    renderTable();
    fireEvent.click(screen.getByRole("tab", { name: "Shareholdings 2" }));
    fireEvent.click(screen.getByRole("button", { name: /^Self/ }));
    expect(visibleTexts()).toEqual(["BHP Group Limited"]);

    fireEvent.click(screen.getByRole("button", { name: /Clear filters/i }));
    expect(visibleTexts()).toHaveLength(ROWS.length);
    expect(screen.queryByRole("button", { name: /Clear filters/i })).toBeNull();
  });

  it("says a filter matched nothing, never that the member declared nothing", () => {
    renderTable();
    fireEvent.change(screen.getByLabelText(/Filter declarations by text/i), {
      target: { value: "zzzz" },
    });
    expect(screen.getByText("No entries match this filter.")).toBeInTheDocument();
    // An absence claim about a named person is the CoverageNote's job, and only
    // where the documents have actually been read.
    const text = screen.getByRole("tabpanel").textContent ?? "";
    expect(text).not.toMatch(/declared nothing|no interests|holds nothing/i);
  });

  it("renders nothing at all rather than empty chrome for a member with no rows", () => {
    const { container } = renderTable([]);
    expect(container).toBeEmptyDOMElement();
  });

  it("is navigable: labelled tabs, a labelled filter, and a live count", () => {
    renderTable();
    expect(screen.getByRole("tablist")).toHaveAccessibleName(
      /Filter declarations by register category/i,
    );
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab).toHaveAttribute("aria-selected");
      expect(tab).toHaveAttribute("aria-controls", "declaration-panel");
    }
    expect(screen.getByRole("tabpanel")).toHaveAttribute("id", "declaration-panel");
    expect(screen.getByLabelText(/Filter declarations by text/i)).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("sorts by period with undated entries always last, and resets", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: /Period/ }));
    // Ascending by declared-from; the undated Manly entry sorts last rather
    // than masquerading as 1970.
    expect(visibleTexts()).toEqual([
      "Woodside Energy",
      "Residence, Coogee NSW",
      "BHP Group Limited",
      "Mortgage with a bank",
      "Investment, Manly NSW",
    ]);
    fireEvent.click(screen.getByRole("button", { name: /Period/ }));
    expect(visibleTexts()[0]).toBe("Mortgage with a bank");
    expect(visibleTexts()[4]).toBe("Investment, Manly NSW");
    // A user-applied sort interleaves categories, so the group headings leave.
    expect(screen.queryByRole("heading", { name: /Shareholdings/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Reset order/ }));
    expect(screen.getByRole("heading", { name: /Shareholdings/ })).toBeInTheDocument();
  });

  it("sorts by what is declared, alphabetically over the visible name", () => {
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: "Declared" }));
    expect(visibleTexts()[0]).toBe("BHP Group Limited");
    expect(visibleTexts()[4]).toBe("Woodside Energy");
  });

  it("carries no currency, warning or trophy iconography and no accusatory verb", () => {
    const { container } = renderTable();
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/[⚠🚨🔴🚩👀💰💵🪙💲🏆]/u);
    expect(text).not.toMatch(
      /\b(profit\w*|insider|corrupt\w*|bet against|rort\w*|kickback|worth|risk)\b/i,
    );
  });
});
