import { act, fireEvent, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { StrictMode } from "react";

import { RegistersExplorer, type RegistersExplorerProps, type RegistersPage } from "../registers-explorer";
import { OUTAGE_AFTER_MS, type RegisterStockRow } from "../register-rows-table";
import { KIND_ORDER, kindInfo } from "~/@/lib/ownership/kinds";
import { defaultRegistersQuery } from "~/@/lib/ownership/query";

// The link the reader arrives with. The island reads it through useSearchParams,
// which these tests drive: a move of the link is a new value and a re-render, as
// the router gives it. mockSuspend makes that read suspend, so what is on the
// screen is the Suspense fallback.
let mockSearchParams = new URLSearchParams("");
let mockSuspend = false;
jest.mock("next/navigation", () => ({
  useSearchParams: () => {
    if (mockSuspend) throw new Promise<never>(() => undefined);
    return mockSearchParams;
  },
}));

const BASE = "/ownership/stocks";
// registers.outage (section 7.1): the register list's own outage, never the notice feed's.
const OUTAGE =
  "The registers could not be read just now. Nothing here is missing from the register: this is our end.";
const CAPTION = "What the notices disclose, each interest counted once; not a share of the company.";
const TABLE_NAME = "ASX substantial holder registers by stock";

/** A stock as the action maps it: strings the page prints, and the bar's numbers. */
const BHP: RegisterStockRow = {
  code: "BHP",
  companyName: "BHP Group",
  industry: "Materials",
  interests: "7",
  disclosed: "41.20%",
  disclosedPct: 41.2,
  byKind: [
    { kind: "super_fund", pct: 30.1, holders: 3 },
    { kind: "bank_broker", pct: 11.1, holders: 4 },
  ],
  institutions: "30.10%",
  banks: "11.10%",
  hedgeActive: "0.00%",
  index: "5.20%",
  indexAsAt: "as at 2026-09-30 to 2026-10-01",
  superOptions: "4",
  superValue: "$1.2B",
  short: "3.42%",
  shortAsOf: "2026-10-01",
  latestNotice: "2026-10-16",
};

const CBA: RegisterStockRow = {
  ...BHP,
  code: "CBA",
  companyName: "Commonwealth Bank",
  industry: "Financials",
  interests: "2",
  disclosed: "9.50%",
  disclosedPct: 9.5,
  byKind: [{ kind: "index_manager", pct: 9.5, holders: 2 }],
  institutions: "9.50%",
  banks: "n/a",
  hedgeActive: "n/a",
  index: "n/a",
  indexAsAt: undefined,
  superOptions: "0",
  superValue: "n/a",
  short: "n/a",
  shortAsOf: undefined,
  latestNotice: "",
};

function registersPage(overrides: Partial<RegistersPage> = {}): RegistersPage {
  return {
    ok: true,
    query: defaultRegistersQuery(),
    rows: [BHP, CBA],
    total: 2,
    industries: [
      { industry: "Materials", stocks: 12 },
      { industry: "Financials", stocks: 30 },
    ],
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A control by the end of its id: the island's ids are generated, so the suffix is the name. */
function select(name: string): HTMLSelectElement {
  const el = document.querySelector<HTMLSelectElement>(`select[id$="-${name}"]`);
  if (!el) throw new Error(`no select ${name}`);
  return el;
}

function registerTable(): HTMLElement {
  return screen.getByRole("table", { name: TABLE_NAME });
}

function group(label: string): HTMLElement {
  return screen.getByRole("group", { name: label });
}

let loadPage: jest.Mock;
let view: RenderResult;
let props: RegistersExplorerProps;

beforeEach(() => {
  mockSearchParams = new URLSearchParams("");
  mockSuspend = false;
  loadPage = jest.fn();
});

afterEach(() => {
  jest.useRealTimers();
  window.history.replaceState(null, "", "/");
});

function renderRegisters(initial: RegistersPage = registersPage()) {
  props = { initial, loadPage, basePath: BASE };
  view = render(<RegistersExplorer {...props} />);
  return view;
}

/** The list under StrictMode, which runs every effect's cleanup and then its setup again on mount. */
function renderRegistersStrict(initial: RegistersPage = registersPage()) {
  props = { initial, loadPage, basePath: BASE };
  view = render(
    <StrictMode>
      <RegistersExplorer {...props} />
    </StrictMode>,
  );
  return view;
}

/** The reader moves the link, as a chip's navigation does. The island reads the new link on its next render. */
function moveTo(search: string) {
  mockSearchParams = new URLSearchParams(search);
  view.rerender(<RegistersExplorer {...props} />);
}

describe("registers explorer", () => {
  it("draws the server's default view and asks for nothing on mount", () => {
    renderRegisters();
    expect(loadPage).not.toHaveBeenCalled();
    expect(within(registerTable()).getByRole("link", { name: "BHP" })).toHaveAttribute("href", `${BASE}/BHP`);
    expect(screen.getByText("1–2 of 2 stocks")).toBeInTheDocument();
  });

  it("builds the industry chips from the response's industries, and the kind chips from the kind vocabulary", () => {
    renderRegisters();
    const industries = within(group("Industry")).getAllByRole("link");
    expect(industries.map((chip) => chip.textContent)).toEqual(["All industries", "Materials12", "Financials30"]);
    expect(within(group("Industry")).getByRole("link", { name: "All industries" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(within(group("Industry")).getByRole("link", { name: "Materials 12" })).toHaveAttribute(
      "href",
      `${BASE}?industry=Materials`,
    );
    const kinds = within(group("Kind")).getAllByRole("link");
    expect(kinds).toHaveLength(KIND_ORDER.length + 1);
    expect(within(group("Kind")).getByRole("link", { name: "Super fund" })).toHaveAttribute(
      "href",
      `${BASE}?kind=super_fund`,
    );
  });

  it("draws the other and unclassified kinds as an outline in their chips, as the disclosed bar draws them", () => {
    renderRegisters();
    const swatchOf = (name: string) => within(group("Kind")).getByRole("link", { name }).querySelector("span");
    expect(swatchOf("Super fund")).toHaveClass("bg-[#87A96B]");
    for (const name of ["Other", "Unclassified"]) {
      const swatch = swatchOf(name)!;
      expect(swatch.className).not.toMatch(/bg-\[/);
      expect(swatch.style.boxShadow).toContain("inset");
    }
    expect(kindInfo("other").swatch).toMatch(/bg-\[/);
  });

  it("marks every chip nofollow, so a filtered view is not indexed as a page of its own", () => {
    renderRegisters();
    const chip = within(group("Kind")).getByRole("link", { name: "Super fund" });
    expect(chip).toHaveAttribute("rel", "nofollow");
  });

  it("offers the short filter 0, 1, 3, 5 and 10 only", () => {
    renderRegisters();
    expect(Array.from(select("short").options).map((option) => option.value)).toEqual(["0", "1", "3", "5", "10"]);
  });

  it("asks for the short step the reader picked, and writes it into the link", async () => {
    renderRegisters();
    loadPage.mockResolvedValue(
      registersPage({ query: { ...defaultRegistersQuery(), minShortPct: 5 }, rows: [BHP], total: 1 }),
    );
    fireEvent.change(select("short"), { target: { value: "5" } });
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ minShortPct: 5, offset: 0 }));
    expect(await within(registerTable()).findByRole("link", { name: "BHP" })).toBeInTheDocument();
    expect(window.location.search).toBe("?short=5");
    expect(select("short")).toHaveValue("5");
  });

  it("answers a link that names an industry and a sort on mount, asked once", async () => {
    mockSearchParams = new URLSearchParams("industry=Materials&sort=short&dir=asc");
    loadPage.mockResolvedValue(
      registersPage({
        query: { ...defaultRegistersQuery(), industry: "Materials", sort: "short", ascending: true },
        rows: [BHP],
        total: 1,
      }),
    );
    renderRegisters();
    await within(registerTable()).findByRole("link", { name: "BHP" });
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage.mock.calls[0]![0]).toMatchObject({ industry: "Materials", sort: "short", ascending: true });
    expect(within(registerTable()).getByRole("columnheader", { name: /^Short/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("pages forward by the page size, from the offset on screen", async () => {
    renderRegisters(registersPage({ total: 120 }));
    loadPage.mockResolvedValue(
      registersPage({ query: { ...defaultRegistersQuery(), offset: 50 }, rows: [CBA], total: 120 }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 50 }));
    expect(await within(registerTable()).findByRole("link", { name: "CBA" })).toBeInTheDocument();
    expect(window.location.search).toBe("?offset=50");
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
  });

  it("says an answered empty list is a filter, not a claim about the register", async () => {
    renderRegisters();
    loadPage.mockResolvedValue(registersPage({ rows: [], total: 0 }));
    fireEvent.change(select("short"), { target: { value: "10" } });
    expect(await screen.findByText("No stock matches these filters.")).toBeInTheDocument();
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(screen.getByText("0 stocks")).toHaveAttribute("role", "status");
  });

  it("prints what the four sums are under the table, on every width, not only in the table's hidden caption", () => {
    renderRegisters();
    const line = screen.getByText(CAPTION);
    expect(line).toBeVisible();
    // toBeVisible runs without the stylesheet, so the classes are what say it shows on every width. A variant hides it
    // at a width just as the bare token does, so the prefixes count too: the named ones (md:hidden, max-sm:sr-only) and
    // the arbitrary ones ([@container(min-width:980px)]:hidden, max-[640px]:hidden, [@media(max-width:639px)]:sr-only).
    expect(line.className).not.toMatch(/(^|\s)(?:\S+:)?(?:hidden|sr-only)(\s|$)/);
    expect(line.closest("table")).toBeNull();
    expect(registerTable().closest("[aria-busy]")).toContainElement(line);
  });

  it("shows the outage line and no rows when the read fails", async () => {
    renderRegisters();
    loadPage.mockRejectedValue(new Error("network"));
    fireEvent.change(select("short"), { target: { value: "3" } });
    expect(await screen.findByText(OUTAGE)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: TABLE_NAME })).toBeNull();
    expect(screen.queryByText("No stock matches these filters.")).toBeNull();
  });

  it("treats an answer that is not ok as an outage, not as an empty list", async () => {
    renderRegisters();
    loadPage.mockResolvedValue(registersPage({ ok: false, rows: [], total: 0 }));
    fireEvent.change(select("short"), { target: { value: "1" } });
    expect(await screen.findByText(OUTAGE)).toBeInTheDocument();
    expect(screen.queryByText("No stock matches these filters.")).toBeNull();
  });

  it("draws a shell the server could not render as loading, with no count and no zero, then asks once", async () => {
    loadPage.mockResolvedValue(registersPage());
    renderRegisters(registersPage({ ok: false, rows: [], total: 0, industries: [] }));
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(screen.queryByText("0 stocks")).toBeNull();
    await act(async () => undefined);
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(screen.getByText("1–2 of 2 stocks")).toBeInTheDocument();
  });

  it("asks for an industry a chip names on a shell, once the list has answered, and marks the chip", async () => {
    // The shell asks once on mount, so its answer is set before the render.
    loadPage.mockResolvedValueOnce(registersPage());
    renderRegisters(registersPage({ ok: false, rows: [], total: 0, industries: [] }));
    await act(async () => undefined);
    expect(loadPage).toHaveBeenCalledTimes(1);
    loadPage.mockResolvedValueOnce(
      registersPage({ query: { ...defaultRegistersQuery(), industry: "Materials" }, rows: [BHP], total: 1 }),
    );
    moveTo("industry=Materials");
    expect(loadPage).toHaveBeenLastCalledWith(expect.objectContaining({ industry: "Materials" }));
    expect(await within(registerTable()).findByRole("link", { name: "BHP" })).toBeInTheDocument();
    expect(within(group("Industry")).getByRole("link", { name: "Materials 12" })).toHaveAttribute(
      "aria-current",
      "true",
    );
  });

  it("draws the default view as the Suspense fallback while the link is read, and asks for nothing", () => {
    mockSuspend = true;
    renderRegisters();
    expect(within(registerTable()).getByRole("link", { name: "BHP" })).toHaveAttribute("href", `${BASE}/BHP`);
    expect(screen.getByText("1–2 of 2 stocks")).toBeInTheDocument();
    expect(group("Industry")).toBeInTheDocument();
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("draws a shell's fallback as loading, with no outage and no count", () => {
    mockSuspend = true;
    renderRegisters(registersPage({ ok: false, rows: [], total: 0, industries: [] }));
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(screen.queryByText("0 stocks")).toBeNull();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("keeps the rows dimmed and says it is an outage after ten seconds in flight", async () => {
    jest.useFakeTimers();
    renderRegisters();
    const pending = deferred<RegistersPage>();
    loadPage.mockReturnValue(pending.promise);
    fireEvent.change(select("short"), { target: { value: "3" } });
    act(() => {
      jest.advanceTimersByTime(OUTAGE_AFTER_MS - 1);
    });
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(registerTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByText(OUTAGE)).toBeInTheDocument();
    expect(registerTable()).toBeInTheDocument();
    await act(async () => {
      pending.resolve(registersPage({ query: { ...defaultRegistersQuery(), minShortPct: 3 }, rows: [BHP], total: 1 }));
    });
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(registerTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });

  it("is never red or green on a figure, a chip or a bar", () => {
    const { container } = renderRegisters();
    expect(container.innerHTML).not.toMatch(
      /\b(?:text|bg|border|fill|stroke|ring|decoration)-(?:red|green)\b|#EF4444|#22C55E|#F87171|#4ADE80/i,
    );
  });

  it("keeps the industry the reader chose in every sort head's link, before the answer arrives", () => {
    mockSearchParams = new URLSearchParams("industry=Materials");
    loadPage.mockReturnValue(new Promise(() => undefined));
    renderRegisters();
    expect(loadPage).toHaveBeenCalledTimes(1);
    const short = within(registerTable()).getByRole("columnheader", { name: /^Short/ });
    expect(within(short).getByRole("link")).toHaveAttribute("href", `${BASE}?sort=short&industry=Materials`);
  });

  it("keeps the industry a link names on a shell, which lists none to check it against", async () => {
    mockSearchParams = new URLSearchParams("industry=Materials");
    loadPage.mockResolvedValue(
      registersPage({ query: { ...defaultRegistersQuery(), industry: "Materials" }, rows: [BHP], total: 1 }),
    );
    renderRegisters(registersPage({ ok: false, rows: [], total: 0, industries: [] }));
    await act(async () => undefined);
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ industry: "Materials" }));
  });

  it("shows the search text a link names as a chip, and the chip takes it away", () => {
    mockSearchParams = new URLSearchParams("q=bh");
    loadPage.mockReturnValue(new Promise(() => undefined));
    renderRegisters();
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ query: "bh" }));
    // The chip shows the search, and its name starts with what it shows (WCAG 2.5.3) and says what a press does: it
    // clears the search, so it is no current choice.
    const chip = screen.getByRole("link", { name: 'Matching "bh", clear search' });
    expect(chip).toHaveTextContent('Matching "bh"');
    expect(chip).toHaveAttribute("href", BASE);
    expect(chip).not.toHaveAttribute("aria-current");
  });

  it("says a page past the last stock is past it, and offers the first page", async () => {
    renderRegisters();
    loadPage.mockResolvedValue(
      registersPage({ query: { ...defaultRegistersQuery(), offset: 5000 }, rows: [], total: 900 }),
    );
    moveTo("offset=5000");
    expect(await screen.findByText("This page is past the last stock.")).toBeInTheDocument();
    const first = screen.getByRole("link", { name: "First page" });
    expect(first).toHaveAttribute("href", BASE);
    // A filter link: followed, but not indexed as a page of its own.
    expect(first).toHaveAttribute("rel", "nofollow");
    expect(screen.getByText("900 stocks")).toBeInTheDocument();
    expect(screen.queryByText("No stock matches these filters.")).toBeNull();
  });

  it("says the wait in the list's place while a change has no rows to dim", () => {
    renderRegisters(registersPage({ rows: [], total: 0 }));
    loadPage.mockReturnValue(new Promise(() => undefined));
    fireEvent.change(select("short"), { target: { value: "10" } });
    const wait = screen.getByRole("status", { name: "Loading" });
    expect(wait).toHaveAttribute("aria-busy", "true");
    expect(wait).toHaveTextContent("Loading…");
  });

  it("clears the outage timer when the register leaves the screen", () => {
    jest.useFakeTimers();
    renderRegisters();
    loadPage.mockReturnValue(new Promise(() => undefined));
    fireEvent.change(select("short"), { target: { value: "3" } });
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it("asks for nothing under StrictMode while the link is the default view the server drew", () => {
    renderRegistersStrict();
    expect(loadPage).not.toHaveBeenCalled();
    expect(registerTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });

  it("asks a non-default link again after StrictMode's remount, and draws the list it answers", async () => {
    mockSearchParams = new URLSearchParams("sort=short&dir=asc");
    loadPage.mockResolvedValue(
      registersPage({ query: { ...defaultRegistersQuery(), sort: "short", ascending: true }, rows: [BHP], total: 1 }),
    );
    renderRegistersStrict();
    await waitFor(() => expect(screen.getByText("1–1 of 1 stocks")).toBeInTheDocument());
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ sort: "short", ascending: true }));
    expect(registerTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });

  it("asks a shell again after StrictMode's remount, and draws the list it answers", async () => {
    loadPage.mockResolvedValue(registersPage());
    renderRegistersStrict(registersPage({ ok: false, rows: [], total: 0, industries: [] }));
    expect(await screen.findByText("1–2 of 2 stocks")).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }));
    expect(registerTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });
});
