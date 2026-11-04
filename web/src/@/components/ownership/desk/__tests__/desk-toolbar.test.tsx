/// <reference types="jest" />

/**
 * The Overview's toolbar (spec 14.3, Overview; spec 14.7): a stock pick selects it in
 * place, a holder pick opens its profile, and Source writes the lens the panes read.
 */

import { fireEvent, render, screen } from "@testing-library/react";

import { DeskToolbar } from "../desk-toolbar";

let mockSearchParams = new URLSearchParams("");
const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
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

describe("DeskToolbar (spec 14.3, Overview)", () => {
  beforeEach(() => {
    mockSearchParams = new URLSearchParams("");
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
    const source = screen.getByRole("radiogroup", { name: "Source" });
    expect(source.querySelector("input[value='index']")).toBeChecked();
    fireEvent.click(screen.getByLabelText("Substantial notices"));
    expect(window.location.search).toBe("");
  });
});
