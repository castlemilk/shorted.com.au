/// <reference types="jest" />

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HolderInspector } from "../holder-inspector";
import type { HolderInspectorContent } from "~/@/components/ownership/holders/holder-tree";
import { fundHref } from "~/@/lib/ownership/kinds";

let mockSearch = "";
jest.mock("next/navigation", () => ({
  usePathname: () => "/ownership/holders",
  useRouter: () => ({ prefetch: jest.fn(), replace: jest.fn() }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const holderContent = (heading: string): HolderInspectorContent => ({
  heading,
  logo: { kind: "holder", name: heading, holderKind: "index_manager", website: "", holderKey: "vanguard" },
  badges: ["Index manager"],
  rows: [{ label: "Disclosed positions", value: "157" }],
  primary: { label: "Open holder profile →", href: "/ownership/vanguard" },
  funds: [],
  connectionLink: null,
});

describe("holder inspector (spec 14.3)", () => {
  beforeEach(() => {
    mockSearch = "";
  });

  it("shows the initial holder with nothing selected, without asking for it again", () => {
    const resolve = jest.fn(async () => holderContent("Other"));
    render(
      <HolderInspector initial={holderContent("Vanguard")} defaultKey="vanguard" resolve={resolve} />,
    );
    expect(screen.getByRole("heading", { name: "Vanguard" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open holder profile →" })).toHaveAttribute("href", "/ownership/vanguard");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("reads the selection through the resolver and draws its section", async () => {
    mockSearch = "sel=stock%3ABHP";
    const resolve = jest.fn(async (): Promise<HolderInspectorContent> => ({
      ...holderContent("Vanguard"),
      sections: [{ title: "Selected connection", kind: "rows", items: [{ label: "Sector", value: "Materials" }] }],
    }));
    render(<HolderInspector initial={holderContent("Vanguard")} defaultKey="vanguard" resolve={resolve} />);
    expect(await screen.findByText("Materials")).toBeInTheDocument();
    expect(resolve).toHaveBeenCalledWith("vanguard", "stock:BHP");
  });

  it("names the holder a page pins, whatever the URL says", async () => {
    mockSearch = "holder=regal";
    const resolve = jest.fn(async () => holderContent("Vanguard"));
    render(
      <HolderInspector initial={holderContent("Vanguard")} defaultKey="vanguard" fixedKey="vanguard" resolve={resolve} />,
    );
    expect(screen.getByRole("heading", { name: "Vanguard" })).toBeInTheDocument();
    await waitFor(() => expect(resolve).not.toHaveBeenCalled());
  });

  it("has no Clear selection control of its own: the connections map's footer clears the selection", async () => {
    mockSearch = "sel=stock%3ABHP";
    const resolve = jest.fn(async () => holderContent("Vanguard"));
    render(<HolderInspector initial={holderContent("Vanguard")} defaultKey="vanguard" resolve={resolve} />);
    await waitFor(() => expect(resolve).toHaveBeenCalled());
    expect(screen.queryByRole("button", { name: "Clear selection" })).toBeNull();
  });

  it("keeps the held heading under aria-busy while a new selection on the same holder resolves", () => {
    const resolve = jest.fn(() => new Promise<HolderInspectorContent>(() => undefined));
    const { rerender } = render(
      <HolderInspector initial={holderContent("Vanguard")} defaultKey="vanguard" resolve={resolve} />,
    );
    mockSearch = "sel=stock%3ABHP";
    rerender(<HolderInspector initial={holderContent("Vanguard")} defaultKey="vanguard" resolve={resolve} />);
    const heading = screen.getByRole("heading", { name: "Vanguard" });
    expect(heading.closest('[aria-busy="true"]')).not.toBeNull();
  });

  it("heads a selected company's card as a selected connection", () => {
    const content = { ...holderContent("Vanguard"), selectionHeading: "Selected connection" };
    render(<HolderInspector initial={content} defaultKey="vanguard" resolve={jest.fn(async () => content)} />);
    expect(screen.getByText("Selected connection")).toBeInTheDocument();
  });

  it("links a fund by its encoded key, so a key with a slash and spaces reaches its own page", () => {
    const key = "vanguard/Vanguard Australian Shares Index Fund";
    const content: HolderInspectorContent = {
      ...holderContent("Vanguard"),
      funds: [{ key, name: "Vanguard Australian Shares Index Fund", asxCode: "VAS", fundType: "etf", sizeAud: null }],
    };
    render(<HolderInspector initial={content} defaultKey="vanguard" resolve={jest.fn(async () => content)} />);
    fireEvent.click(screen.getByRole("tab", { name: "Funds & products" }));
    // A fund is labelled by its ticker (spec 14.8); its name is the link's title.
    expect(screen.getByRole("link", { name: "VAS" })).toHaveAttribute("title", "Vanguard Australian Shares Index Fund");
    expect(screen.getByRole("link", { name: "VAS" })).toHaveAttribute(
      "href",
      fundHref(key),
    );
  });

  it("says a holder that is not listed, or could not be read, rather than blaming the register", async () => {
    mockSearch = "sel=stock%3AXYZ";
    const resolve = jest.fn(async () => null);
    render(<HolderInspector initial={null} defaultKey="vanguard" resolve={resolve} />);
    expect(await screen.findByText(/This holder is not listed, or could not be read just now/)).toBeInTheDocument();
  });

  it("draws the manager-level footnote directly under the tab row, above the tab's content", () => {
    const content: HolderInspectorContent = {
      ...holderContent("Vanguard"),
      footnote: "Manager-level notices are separate from individual fund portfolios.",
      sections: [{ title: "Selected connection", kind: "rows", items: [{ label: "Sector", value: "Materials" }] }],
    };
    render(<HolderInspector initial={content} defaultKey="vanguard" resolve={jest.fn(async () => content)} />);
    const note = screen.getByText("Manager-level notices are separate from individual fund portfolios.");
    const tabs = screen.getByRole("tablist", { name: "Holder detail" });
    const section = screen.getByRole("region", { name: "Selected connection" });
    expect(tabs.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(note.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps an unsafe notice label as text, with no link", () => {
    const content: HolderInspectorContent = {
      ...holderContent("Vanguard"),
      connectionLink: { label: "View the underlying notice", href: "", external: true },
    };
    render(<HolderInspector initial={content} defaultKey="vanguard" resolve={jest.fn(async () => content)} />);
    expect(screen.getByText("View the underlying notice")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /View the underlying notice/ })).toBeNull();
  });

  describe("below lg", () => {
    const original = window.matchMedia;
    const dialog = HTMLDialogElement.prototype as unknown as {
      showModal: () => void;
      close: () => void;
    };
    beforeEach(() => {
      // jsdom has no modal dialog: the sheet's <dialog> opens by its attribute.
      dialog.showModal = function showModal(this: HTMLDialogElement) {
        this.setAttribute("open", "");
      };
      dialog.close = function close(this: HTMLDialogElement) {
        this.removeAttribute("open");
      };
      window.matchMedia = jest.fn().mockImplementation(() => ({
        matches: false,
        addEventListener: jest.fn(),
        removeEventListener: jest.fn(),
      })) as unknown as typeof window.matchMedia;
    });
    afterEach(() => {
      window.matchMedia = original;
    });

    it("opens the sheet when a holder is picked, with nothing selected", async () => {
      const resolve = jest.fn(async () => holderContent("Other"));
      const { rerender } = render(
        <HolderInspector initial={holderContent("Vanguard")} defaultKey="vanguard" resolve={resolve} />,
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      mockSearch = "holder=regal";
      rerender(<HolderInspector initial={holderContent("Vanguard")} defaultKey="vanguard" resolve={resolve} />);
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(resolve).toHaveBeenCalledWith("regal", "");
    });
  });
});
