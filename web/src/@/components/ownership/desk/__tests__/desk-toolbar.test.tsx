/// <reference types="jest" />

/**
 * The Overview's toolbar (spec 14.3, Overview; backlog B2): one row, the search first, then Source and
 * the window. A stock pick selects it in place, a holder pick opens its profile, Source writes the lens
 * the panes read, and the window writes its link in place. Below `sm` the row folds under "Adjust view".
 */

import { fireEvent, render, screen, within } from "@testing-library/react";

import { DeskToolbar } from "../desk-toolbar";

let mockSearchParams = new URLSearchParams("");
// While set, the island's URL read suspends, so only the server's fallback draws (the default view).
let mockHoldSearchParams = false;
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useSearchParams: () => {
    if (mockHoldSearchParams) throw new Promise(() => {});
    return mockSearchParams;
  },
  useRouter: () => ({ replace: jest.fn(), push: mockPush, prefetch: jest.fn() }),
}));

// The combobox is the Gamma component's own behaviour; the toolbar's contract is what it is handed back.
jest.mock("~/@/components/gamma/SearchCombobox", () => ({
  SearchCombobox: ({ label, onValueChange }: { label: string; onValueChange: (value: string | null) => void }) => (
    <div>
      <button type="button" onClick={() => onValueChange("stock:PLS")}>
        {`${label}: pick PLS`}
      </button>
      <button type="button" onClick={() => onValueChange("holder:vanguard")}>
        {`${label}: pick Vanguard`}
      </button>
    </div>
  ),
}));

const STOCKS = [{ code: "PLS", name: "PLS Group" }];
const HOLDERS = [{ slug: "vanguard", name: "Vanguard" }];

describe("DeskToolbar (spec 14.3, Overview; backlog B2)", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams("");
    mockHoldSearchParams = false;
    mockPush.mockClear();
    window.history.replaceState(null, "", "/ownership");
  });

  it("selects a picked stock in place, writing sel=stock:CODE with no navigation", () => {
    const replace = jest.spyOn(window.history, "replaceState");
    render(<DeskToolbar stocks={STOCKS} holders={HOLDERS} />);
    fireEvent.click(screen.getByRole("button", { name: "Find a stock or holder: pick PLS" }));
    expect(replace).toHaveBeenCalled();
    expect(window.location.search).toBe("?sel=stock%3APLS");
    expect(mockPush).not.toHaveBeenCalled();
    replace.mockRestore();
  });

  it("opens a picked holder's profile", () => {
    render(<DeskToolbar stocks={STOCKS} holders={HOLDERS} />);
    fireEvent.click(screen.getByRole("button", { name: "Find a stock or holder: pick Vanguard" }));
    expect(mockPush).toHaveBeenCalledWith("/ownership/vanguard");
  });

  it("writes lens=index for Source = Index fund holdings, and clears it for substantial notices", () => {
    window.history.replaceState(null, "", "/ownership?lens=index");
    mockSearchParams = new URLSearchParams("lens=index");
    render(<DeskToolbar stocks={STOCKS} holders={HOLDERS} />);
    const source = screen.getByRole("combobox", { name: "Source" });
    expect(source).toHaveValue("index");
    fireEvent.change(source, { target: { value: "disclosed" } });
    expect(window.location.search).toBe("");
    fireEvent.change(source, { target: { value: "index" } });
    expect(new URLSearchParams(window.location.search).get("lens")).toBe("index");
  });

  it("writes the window in place, keeping the reader's other parameters", () => {
    window.history.replaceState(null, "", "/ownership?lens=index");
    mockSearchParams = new URLSearchParams("lens=index");
    render(<DeskToolbar stocks={STOCKS} holders={HOLDERS} />);
    const window28 = screen.getByRole("combobox", { name: "Window" });
    expect(window28).toHaveValue("91");
    fireEvent.change(window28, { target: { value: "28" } });
    const written = new URLSearchParams(window.location.search);
    expect(written.get("window")).toBe("28");
    expect(written.get("lens")).toBe("index");
  });

  it("draws the search, Source and Window in one toolbar row, folded under 'Adjust view'", () => {
    render(<DeskToolbar stocks={STOCKS} holders={HOLDERS} />);
    const row = document.querySelector("[data-toolbar]") as HTMLElement;
    expect(row).not.toBeNull();
    expect(within(row).getByRole("button", { name: "Find a stock or holder: pick PLS" })).toBeInTheDocument();
    expect(within(row).getByRole("combobox", { name: "Source" })).toBeInTheDocument();
    expect(within(row).getByRole("combobox", { name: "Window" })).toBeInTheDocument();
    // The search comes first in the row.
    expect(row.firstElementChild?.querySelector("button")).toHaveTextContent("Find a stock or holder: pick PLS");
    const fold = row.closest("details");
    expect(fold?.querySelector("summary")).toHaveTextContent("Adjust view");
  });

  describe("the plate slot (backlog D2)", () => {
    const PLATE = <p data-testid="plate">Notices read to 2026-11-03 · Not financial advice</p>;

    it("draws the plate once, as the first child of the fold's content, above the row", () => {
      render(<DeskToolbar stocks={STOCKS} holders={HOLDERS} plate={PLATE} />);
      const plate = screen.getByTestId("plate");
      const row = document.querySelector("[data-toolbar]") as HTMLElement;
      const fold = row.closest("details") as HTMLElement;

      expect(document.querySelectorAll("[data-testid='plate']")).toHaveLength(1);
      expect(fold.querySelector("summary")).toHaveTextContent("Adjust view");
      // The fold's content is the block after the summary; the plate and the row share its first child.
      const content = fold.querySelector("summary")?.nextElementSibling as HTMLElement;
      expect(content.firstElementChild).toBe(plate.parentElement);
      expect(plate.parentElement?.firstElementChild).toBe(plate);
      expect(plate.parentElement).toContainElement(row);
      // The block is a plain block with space-y, not a flex column: the plate is an inline-flex pill that a
      // flex item would stretch to the full width (the bordered plate became a bar at every breakpoint).
      expect(plate.parentElement).toHaveClass("space-y-3");
      expect(plate.parentElement).not.toHaveClass("flex");
      expect(plate.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it("draws the plate above the row with no fold on the server's default view", () => {
      mockHoldSearchParams = true;
      try {
        render(<DeskToolbar stocks={STOCKS} holders={HOLDERS} plate={PLATE} />);
        const plate = screen.getByTestId("plate");
        const row = document.querySelector("[data-toolbar]") as HTMLElement;

        expect(document.querySelectorAll("[data-testid='plate']")).toHaveLength(1);
        expect(row.closest("details")).toBeNull();
        expect(plate.parentElement).toContainElement(row);
        expect(plate.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      } finally {
        mockHoldSearchParams = false;
      }
    });

    it("draws no plate element when none is passed, and the row is unchanged", () => {
      render(<DeskToolbar stocks={STOCKS} holders={HOLDERS} />);
      const row = document.querySelector("[data-toolbar]") as HTMLElement;
      expect(row.parentElement?.children).toHaveLength(1);
      expect(row.closest("details")?.querySelector("summary")).toHaveTextContent("Adjust view");
    });
  });
});
