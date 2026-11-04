/// <reference types="jest" />

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { barPercent, Inspector, InspectorFallback } from "../inspector";
import type { InspectorContent } from "../inspector-types";
import { serializeSelection } from "../selection";
import { trailKey } from "../trail";

let mockSearch = "";
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  usePathname: () => "/ownership/map",
  useRouter: () => ({ prefetch: jest.fn(), replace: mockReplace }),
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

const content: InspectorContent = {
  heading: "BHP Group",
  badges: ["ASX"],
  figure: { value: "12.4%", caption: "Disclosed by notices" },
  rows: [{ label: "Holders", value: "14" }],
  primary: { label: "Open ownership →", href: "/ownership/stocks/BHP" },
  links: [{ label: "View source", href: "https://example.com/notice.pdf", external: true }],
};

/** jsdom has no modal dialog: a stand-in that sets the open attribute the sheet reads. */
function stubDialog() {
  const proto = (globalThis as { HTMLDialogElement?: { prototype: Record<string, unknown> } })
    .HTMLDialogElement?.prototype;
  if (!proto) return;
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close = function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
}

/** Makes the viewport below `lg` (or at least `lg`) for the sheet's branch. */
function viewport(desktop: boolean) {
  window.matchMedia = jest.fn().mockImplementation(() => ({
    matches: desktop,
    media: "(min-width: 1024px)",
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe("workspace inspector (spec 14.1)", () => {
  beforeEach(() => {
    mockSearch = "";
    mockReplace.mockClear();
    stubDialog();
    viewport(true);
  });

  it("reads one line with nothing selected", async () => {
    const resolve = jest.fn(async () => content);
    render(<Inspector resolve={resolve} emptyText="Click selects. Filter narrows the map." />);
    expect(screen.getByText("Click selects. Filter narrows the map.")).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("draws the page's default view as its Suspense fallback, so the static render carries it", () => {
    const { container } = render(<InspectorFallback emptyText="Select a company to inspect its holding." />);
    expect(screen.getByRole("complementary", { name: "Inspector" })).toBeInTheDocument();
    expect(screen.getByText("Select a company to inspect its holding.")).toBeInTheDocument();
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it("draws a numeric series as a line labelled by its title, a null point as a gap", async () => {
    mockSearch = "sel=stock%3ABHP";
    const weighted: InspectorContent = {
      heading: "BHP",
      rows: [],
      sections: [
        {
          title: "Weight across snapshots",
          kind: "series",
          items: [{ label: "2026-09-30", value: "2.50%" }],
          points: [
            { label: "2026-09-30", value: 2.5 },
            { label: "2026-10-30", value: null },
          ],
        },
      ],
    };
    render(<Inspector resolve={jest.fn(async () => weighted)} emptyText="Select a company." />);
    await waitFor(() => expect(screen.getByRole("img", { name: "Weight across snapshots" })).toBeInTheDocument());
    expect(screen.getByText("2.50%")).toBeInTheDocument();
  });

  it("renders an unsafe external link as its label, never as an href", async () => {
    mockSearch = "sel=stock%3ABHP";
    const unsafe: InspectorContent = {
      heading: "BHP",
      rows: [],
      links: [{ label: "View source files", href: "javascript:alert(1)", external: true }],
    };
    render(<Inspector resolve={jest.fn(async () => unsafe)} emptyText="Select a company." />);
    await waitFor(() => expect(screen.getByText("View source files")).toBeInTheDocument());
    expect(screen.queryByRole("link", { name: /View source files/ })).toBeNull();
  });

  it("asks the page's resolver for the selection and draws its rows", async () => {
    mockSearch = "sel=stock%3ABHP";
    const resolve = jest.fn(async () => content);
    render(<Inspector resolve={resolve} emptyText="Select a company." />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "BHP Group" })).toBeInTheDocument());
    expect(resolve).toHaveBeenCalledWith(
      { kind: "stock", code: "BHP" },
      { lens: "", view: "", window: "", since: "", until: "", asAt: "", from: "", to: "" },
    );
    expect(screen.getByText("Selected company", { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText("12.4%")).toHaveClass("tabular-nums");
    expect(screen.getByRole("link", { name: "Open ownership →" })).toHaveAttribute(
      "href",
      "/ownership/stocks/BHP",
    );
    expect(screen.getByRole("link", { name: /View source/ })).toHaveAttribute("target", "_blank");
  });

  it("names the aside by its kind alone while the selection loads", () => {
    mockSearch = "sel=stock%3ABHP";
    render(<Inspector resolve={() => new Promise(() => {})} emptyText="Select." />);
    expect(screen.getByRole("complementary", { name: "Selected company" })).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "Loading the selection" })).toBeInTheDocument();
  });

  it("states that nothing is on record when the resolver has nothing", async () => {
    mockSearch = "sel=fund%3Aasx%3AZZZ";
    render(<Inspector resolve={async () => null} emptyText="Select." />);
    await waitFor(() =>
      expect(screen.getByText("Nothing on record for this selection.")).toBeInTheDocument(),
    );
    expect(screen.queryByText("Could not load this selection.")).toBeNull();
  });

  it("says a failed read could not load, offers a retry, and never calls it empty", async () => {
    mockSearch = "sel=stock%3ABHP";
    const resolve = jest
      .fn<Promise<InspectorContent | null>, []>()
      .mockRejectedValueOnce(new Error("outage"))
      .mockResolvedValueOnce(content);
    render(<Inspector resolve={() => resolve()} emptyText="Select." />);
    await waitFor(() => expect(screen.getByText("Could not load this selection.")).toBeInTheDocument());
    expect(screen.queryByText("Nothing on record for this selection.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "BHP Group" })).toBeInTheDocument());
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("does not ask for a malformed selection", async () => {
    mockSearch = "sel=stock%3Abhp";
    const resolve = jest.fn(async () => content);
    render(<Inspector resolve={resolve} emptyText="Select." />);
    expect(screen.getByText("Select.")).toBeInTheDocument();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("opens a sheet below lg with the selection, and closing it clears sel with router.replace", async () => {
    viewport(false);
    mockSearch = "sel=stock%3ABHP&lens=flow";
    render(<Inspector resolve={async () => content} emptyText="Select." />);
    await waitFor(() => expect(document.querySelector("dialog")).not.toBeNull());
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    await waitFor(() => expect(dialog.hasAttribute("open")).toBe(true));
    expect(dialog).toHaveAttribute("data-side", "bottom");
    expect(within(dialog).getByRole("heading", { level: 2, name: "BHP Group" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Clear selection" }));
    expect(mockReplace).toHaveBeenCalledWith("/ownership/map?lens=flow", { scroll: false });
  });
});

describe("workspace inspector blocks (spec 14.1)", () => {
  beforeEach(() => {
    mockSearch = "";
    mockReplace.mockClear();
    stubDialog();
    viewport(true);
  });

  async function drawn(extra: Partial<InspectorContent>) {
    mockSearch = "sel=stock%3ABHP";
    render(<Inspector resolve={async () => ({ ...content, ...extra })} emptyText="Select." />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "BHP Group" })).toBeInTheDocument());
  }

  it("draws the subtitle and every badge beside the name", async () => {
    await drawn({ subtitle: "BHP Group · Materials", badges: ["Company", "Substantial notices"] });
    expect(screen.getByText("BHP Group · Materials")).toBeInTheDocument();
    expect(screen.getByText("Company")).toBeInTheDocument();
    expect(screen.getByText("Substantial notices")).toBeInTheDocument();
  });

  it("draws each titled section in order, with its own rows, series, bars and links", async () => {
    await drawn({
      sections: [
        { title: "Reported interests", kind: "rows", items: [{ label: "Voting power", value: "5.1%" }] },
        { title: "Recent activity", kind: "series", items: [{ label: "2026-10-26", value: "+1" }, { label: "2026-10-26", value: "−2" }] },
        {
          title: "Largest positions",
          kind: "bars",
          items: [{ label: "Vanguard", value: "$1.2bn", share: 0.75 }],
        },
        { title: "Evidence", kind: "list", items: [{ label: "Notice", href: "https://example.com/n.pdf", external: true }] },
      ],
    });
    for (const title of ["Reported interests", "Recent activity", "Largest positions", "Evidence"]) {
      expect(screen.getByRole("region", { name: title })).toBeInTheDocument();
    }
    // Repeated labels (two activity rows on one date) both draw: rows are not keyed by label.
    expect(screen.getAllByText("2026-10-26")).toHaveLength(2);
    expect(screen.getByText("$1.2bn")).toHaveClass("tabular-nums");
    const bar = screen.getByRole("region", { name: "Largest positions" }).querySelector("[style]");
    expect(bar).toHaveStyle({ width: "75%" });
    expect(screen.getByRole("link", { name: /Notice/ })).toHaveAttribute("target", "_blank");
  });

  it("draws the footnote after Clear selection, and the note before the primary action", async () => {
    await drawn({
      note: "Read from the notice.",
      primary: { label: "Open ownership", href: "/ownership/stocks/BHP" },
      footnote: "Selection highlights this company and sector across the workspace.",
    });
    const clear = screen.getByRole("link", { name: "Clear selection" });
    const footnote = screen.getByText("Selection highlights this company and sector across the workspace.");
    expect(clear.compareDocumentPosition(footnote) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const note = screen.getByText("Read from the notice.");
    const primary = screen.getByRole("link", { name: "Open ownership" });
    expect(note.compareDocumentPosition(primary) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("barPercent", () => {
  it("clamps a share to 0 to 100 and reads a non-finite share as an empty bar", () => {
    expect(barPercent(0.5)).toBe(50);
    expect(barPercent(1.7)).toBe(100);
    expect(barPercent(-0.2)).toBe(0);
    expect(barPercent(Number.NaN)).toBe(0);
    expect(barPercent(0.1234)).toBe(12.3);
  });
});

describe("workspace inspector reading (spec 14.1, backlog C1)", () => {
  beforeEach(() => {
    mockSearch = "sel=stock%3ABHP";
    stubDialog();
    viewport(true);
  });

  it("leads the rail with its reading, under the heading and before the figure", async () => {
    const withReading: InspectorContent = { ...content, reading: "Index funds hold 3.41%, up 0.12 pp since 2026-09-30." };
    const { container } = render(
      <Inspector resolve={jest.fn(async () => withReading)} emptyText="Select a company." />,
    );
    const reading = await screen.findByText("Index funds hold 3.41%, up 0.12 pp since 2026-09-30.");
    const heading = screen.getByRole("heading", { name: "BHP Group" });
    const figure = screen.getByText("12.4%");
    expect(heading.compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("ASX").compareDocumentPosition(reading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reading.compareDocumentPosition(figure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reading.tagName).toBe("P");
    expect(reading).toHaveClass("text-sm", "leading-snug", "text-foreground");
    expect(reading).not.toHaveClass("font-serif");
    expect(container.querySelectorAll("p.leading-snug")).toHaveLength(1);
  });

  it("draws no reading line when the content carries none", async () => {
    const { container } = render(<Inspector resolve={jest.fn(async () => content)} emptyText="Select a company." />);
    await screen.findByRole("heading", { name: "BHP Group" });
    expect(container.querySelector("p.leading-snug")).toBeNull();
  });
});

describe("workspace inspector trail (spec 14.1, backlog C2)", () => {
  const PAGE_KEY = trailKey("/ownership/map");
  const contents: Record<string, InspectorContent> = {
    "stock:BHP": { heading: "BHP Group", rows: [{ label: "Holders", value: "14" }] },
    "stock:CBA": { heading: "CBA", rows: [] },
    "holder:state-street": { heading: "State Street", rows: [] },
  };
  const resolve = async (selection: Parameters<typeof serializeSelection>[0]) =>
    contents[serializeSelection(selection)] ?? null;

  /** A sessionStorage stand-in: a Map behind the Storage methods the rail calls. */
  function fakeSessionStorage() {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key: string) => (items.has(key) ? (items.get(key) as string) : null),
      setItem: (key: string, value: string) => {
        items.set(key, String(value));
      },
      removeItem: (key: string) => {
        items.delete(key);
      },
      clear: () => items.clear(),
    };
  }

  let fake: ReturnType<typeof fakeSessionStorage>;
  let original: PropertyDescriptor | undefined;

  beforeEach(() => {
    mockSearch = "";
    mockReplace.mockClear();
    stubDialog();
    viewport(true);
    fake = fakeSessionStorage();
    original = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", { value: fake, configurable: true });
  });

  afterEach(() => {
    if (original) Object.defineProperty(window, "sessionStorage", original);
    else delete (window as { sessionStorage?: unknown }).sessionStorage;
  });

  /** The trail's text as the rail draws it, or null with no trail. */
  function trailText(): string | null {
    return screen.queryByRole("navigation", { name: "Trail" })?.textContent ?? null;
  }

  /**
   * The trail is recorded in an effect, which runs after the heading is on screen, so a test
   * waits on the trail itself rather than on the heading.
   */
  async function flushEffects() {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  /** The trail's steps as the rail draws them: the text of each step and whether it is a link. */
  function trailSteps() {
    const nav = screen.queryByRole("navigation", { name: "Trail" });
    if (nav === null) return null;
    return Array.from(nav.querySelectorAll("a, span[aria-current='step']")).map((el) => ({
      label: el.textContent,
      href: el.getAttribute("href"),
      current: el.getAttribute("aria-current") === "step",
    }));
  }

  it("records a zoomed sector, then a stock, then its holder, and draws the three as a trail", async () => {
    const { rerender } = render(<Inspector resolve={resolve} emptyText="Click selects." />);
    mockSearch = "sector=Materials";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailSteps()).toEqual([{ label: "Materials", href: null, current: true }]));

    mockSearch = "sector=Materials&sel=stock%3ABHP";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailText()).toBe("Materials > BHP Group"));

    mockSearch = "sector=Materials&sel=holder%3Astate-street";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "State Street" })).toBeInTheDocument());
    await waitFor(() => expect(trailText()).toBe("Materials > BHP Group > State Street"));

    const nav = screen.getByRole("navigation", { name: "Trail" });
    expect(trailSteps()).toEqual([
      { label: "Materials", href: "/ownership/map?sector=Materials", current: false },
      { label: "BHP Group", href: "/ownership/map?sector=Materials&sel=stock%3ABHP", current: false },
      { label: "State Street", href: null, current: true },
    ]);
    // The earlier steps are links with the scroll and prefetch the rail's other links use; the current one is text.
    expect(screen.getByRole("link", { name: "BHP Group" })).toHaveAttribute("href", "/ownership/map?sector=Materials&sel=stock%3ABHP");
    expect(screen.getByText("State Street", { selector: "span" })).toHaveAttribute("aria-current", "step");
    expect(screen.queryByRole("link", { name: "State Street" })).toBeNull();
  });

  it("draws a trail of three after three resolved selections, with the earlier two linked", async () => {
    const { rerender } = render(<Inspector resolve={resolve} emptyText="Click selects." />);
    for (const [search, heading] of [
      ["sel=stock%3ABHP", "BHP Group"],
      ["sel=stock%3ACBA", "CBA"],
      ["sel=holder%3Astate-street", "State Street"],
    ] as const) {
      mockSearch = search;
      rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
      await waitFor(() => expect(screen.getByRole("heading", { name: heading })).toBeInTheDocument());
    }
    await waitFor(() => expect(trailText()).toBe("BHP Group > CBA > State Street"));
    expect(trailSteps()).toEqual([
      { label: "BHP Group", href: "/ownership/map?sel=stock%3ABHP", current: false },
      { label: "CBA", href: "/ownership/map?sel=stock%3ACBA", current: false },
      { label: "State Street", href: null, current: true },
    ]);
  });

  it("keeps the trail in sessionStorage under the page's key, never in the link", async () => {
    mockSearch = "sel=stock%3ABHP";
    render(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(fake.items.has(PAGE_KEY)).toBe(true));
    const stored = JSON.parse(fake.items.get(PAGE_KEY) as string);
    expect(stored).toEqual([{ label: "BHP Group", href: "/ownership/map?sel=stock%3ABHP" }]);
  });

  it("does not record a step for a selection with nothing on record", async () => {
    mockSearch = "sel=fund%3Aasx%3AZZZ";
    render(<Inspector resolve={resolve} emptyText="Click selects." />);
    await screen.findByText("Nothing on record for this selection.");
    expect(fake.items.has(PAGE_KEY)).toBe(false);
    expect(screen.queryByRole("navigation", { name: "Trail" })).toBeNull();
  });

  it("keeps the trail when the selection is cleared, so the reader can walk back", async () => {
    mockSearch = "sel=stock%3ABHP";
    const { rerender } = render(<Inspector resolve={resolve} emptyText="Click selects." />);
    await screen.findByRole("heading", { name: "BHP Group" });
    mockSearch = "";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(screen.getByText("Click selects.")).toBeInTheDocument());
    // The page is now the bare link, which is no step's link: every step stays a way back.
    expect(trailSteps()).toEqual([{ label: "BHP Group", href: "/ownership/map?sel=stock%3ABHP", current: false }]);
  });

  it("keeps a zoomed sector's company and holder walkable when the selection is cleared on the sector", async () => {
    const { rerender } = render(<Inspector resolve={resolve} emptyText="Click selects." />);
    mockSearch = "sector=Materials";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailText()).toBe("Materials"));
    mockSearch = "sector=Materials&sel=stock%3ABHP";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailText()).toBe("Materials > BHP Group"));
    // Clear selection lands on the sector's own link: the trail is not cut back to the sector.
    mockSearch = "sector=Materials";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailText()).toBe("Materials > BHP Group"));
    await flushEffects();
    expect(trailSteps()).toEqual([
      { label: "Materials", href: null, current: true },
      { label: "BHP Group", href: "/ownership/map?sector=Materials&sel=stock%3ABHP", current: false },
    ]);
    expect(screen.getByRole("link", { name: "BHP Group" })).toHaveAttribute(
      "href",
      "/ownership/map?sector=Materials&sel=stock%3ABHP",
    );
  });

  it("cuts the trail back when an earlier step is walked to, and grows it again when walked forward", async () => {
    mockSearch = "sel=stock%3ABHP";
    const { rerender } = render(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailText()).toBe("BHP Group"));
    mockSearch = "sel=stock%3ACBA";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailText()).toBe("BHP Group > CBA"));

    // The reader follows the BHP link: the page loads that selection and the trail is cut back to it.
    mockSearch = "sel=stock%3ABHP";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailText()).toBe("BHP Group"));

    // Walking forward again does not grow it past the steps the reader has taken.
    mockSearch = "sel=stock%3ACBA";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailText()).toBe("BHP Group > CBA"));
    await flushEffects();
    expect(trailText()).toBe("BHP Group > CBA");
  });

  it("does not record a new step when only the lens changes on the same selection", async () => {
    mockSearch = "sel=stock%3ABHP";
    const { rerender } = render(<Inspector resolve={resolve} emptyText="Click selects." />);
    await waitFor(() => expect(trailText()).toBe("BHP Group"));
    mockSearch = "sel=stock%3ABHP&lens=flow";
    rerender(<Inspector resolve={resolve} emptyText="Click selects." />);
    await screen.findByRole("heading", { name: "BHP Group" });
    await flushEffects();
    expect(trailText()).toBe("BHP Group");
    expect(JSON.parse(fake.items.get(PAGE_KEY) as string)).toHaveLength(1);
  });

  it("draws a stored trail above the empty prompt when nothing is selected and no sector is zoomed", async () => {
    fake.items.set(PAGE_KEY, JSON.stringify([{ label: "BHP Group", href: "/ownership/map?sel=stock%3ABHP" }]));
    render(<Inspector resolve={resolve} emptyText="Click selects. Filter narrows the map." />);
    const nav = await screen.findByRole("navigation", { name: "Trail" });
    expect(nav.textContent).toBe("BHP Group");
    // Nothing is selected on this page, so the stored step is a way back, not the current step.
    expect(screen.getByRole("link", { name: "BHP Group" })).toHaveAttribute("href", "/ownership/map?sel=stock%3ABHP");
    expect(screen.getByText("Click selects. Filter narrows the map.")).toBeInTheDocument();
    expect(nav.compareDocumentPosition(screen.getByText("Click selects. Filter narrows the map.")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("reads a malformed stored trail as no trail at all", async () => {
    fake.items.set(PAGE_KEY, "[not a trail");
    render(<Inspector resolve={resolve} emptyText="Click selects." />);
    await screen.findByText("Click selects.");
    expect(screen.queryByRole("navigation", { name: "Trail" })).toBeNull();
  });

  it("serves the server's markup first: no trail before the stored one is read", () => {
    fake.items.set(PAGE_KEY, JSON.stringify([{ label: "BHP Group", href: "/ownership/map?sel=stock%3ABHP" }]));
    const { container } = render(<InspectorFallback emptyText="Click selects." />);
    expect(container.querySelector('nav[aria-label="Trail"]')).toBeNull();
  });
});
