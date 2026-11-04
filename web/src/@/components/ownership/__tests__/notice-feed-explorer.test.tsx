import { act, fireEvent, render, screen, waitFor, within, type RenderResult } from "@testing-library/react";
import { StrictMode } from "react";

import {
  NoticeFeedExplorer,
  type NoticeFeedExplorerProps,
  type NoticeFeedPage,
  type NoticeFeedRow,
  type NoticeHolderOption,
} from "../notice-feed-explorer";
import { OUTAGE_AFTER_MS } from "../register-rows-table";
import { defaultNoticeQuery } from "~/@/lib/ownership/query";

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

const BASE = "/ownership/notices";
const OUTAGE =
  "The notices could not be read just now. Nothing here is missing from the register: this is our end.";
const TABLE_NAME = "Substantial holding notices, newest release first";

const HOLDERS: NoticeHolderOption[] = [
  { slug: "zeta-fund", name: "Zeta Fund" },
  { slug: "alpha-super", name: "Alpha Super" },
];

/** A notice as the action maps it: the strings the page prints, and the figures it formatted. */
function feedRow(overrides: Partial<NoticeFeedRow> = {}): NoticeFeedRow {
  return {
    released: "2026-10-16",
    event: "became",
    code: "BHP",
    companyName: "BHP Group",
    holder: "Vanguard Group",
    holderHref: "/ownership/vanguard",
    votingPower: "5.12%",
    change: "",
    url: "https://www.asx.com.au/notices/bhp-1.pdf",
    ...overrides,
  };
}

function feedPage(overrides: Partial<NoticeFeedPage> = {}): NoticeFeedPage {
  return {
    ok: true,
    activityOk: true,
    query: defaultNoticeQuery(),
    rows: [feedRow()],
    total: 1,
    nextCursor: "",
    weeks: [{ weekStart: "2026-10-12", count: 3 }],
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

/** The toolbar's select by its visible label (spec 14.9: one row of labelled selects). */
const SELECT_LABELS = { window: "Window", event: "Event", kind: "Kind", holder: "Holder" } as const;
function select(name: keyof typeof SELECT_LABELS): HTMLSelectElement {
  return screen.getByRole("combobox", { name: SELECT_LABELS[name] }) as HTMLSelectElement;
}

function group(label: string): HTMLElement {
  return screen.getByRole("group", { name: label });
}

function feedTable(): HTMLElement {
  return screen.getByRole("table", { name: TABLE_NAME });
}

let loadPage: jest.Mock;
let view: RenderResult;
let props: NoticeFeedExplorerProps;

beforeEach(() => {
  mockSearchParams = new URLSearchParams("");
  mockSuspend = false;
  loadPage = jest.fn();
});

afterEach(() => {
  jest.useRealTimers();
  window.history.replaceState(null, "", "/");
});

function renderFeed(initial: NoticeFeedPage = feedPage(), holders: NoticeHolderOption[] = HOLDERS) {
  props = { initial, loadPage, holders, basePath: BASE };
  view = render(<NoticeFeedExplorer {...props} />);
  return view;
}

/** The island under StrictMode, which runs every effect's cleanup and then its setup again on mount. */
function renderFeedStrict(initial: NoticeFeedPage = feedPage(), holders: NoticeHolderOption[] = HOLDERS) {
  props = { initial, loadPage, holders, basePath: BASE };
  view = render(
    <StrictMode>
      <NoticeFeedExplorer {...props} />
    </StrictMode>,
  );
  return view;
}

/** The reader moves the link, as a chip's navigation does. The island reads the new link on its next render. */
function moveTo(search: string) {
  mockSearchParams = new URLSearchParams(search);
  view.rerender(<NoticeFeedExplorer {...props} />);
}

/* The client boundary of the notice islands is walked in client-boundary.test.ts. */

describe("notice feed explorer", () => {
  it("draws the server's default view and asks for nothing on mount", () => {
    renderFeed();
    expect(loadPage).not.toHaveBeenCalled();
    const table = feedTable();
    expect(within(table).getByRole("link", { name: "BHP" })).toHaveAttribute("href", "/ownership/stocks/BHP");
    expect(within(table).getByRole("link", { name: "Vanguard Group" })).toHaveAttribute(
      "href",
      "/ownership/vanguard",
    );
    expect(within(table).getByText("Became substantial")).toBeInTheDocument();
    expect(within(table).getByText("5.12%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Notices by week over the last 30 days" })).toBeInTheDocument();
    expect(screen.getByText("1–1 of 1")).toBeInTheDocument();
    // The count line is the live region a filter change is announced in.
    expect(screen.getByText("1–1 of 1")).toHaveAttribute("role", "status");
  });

  it("draws the default view as the Suspense fallback while the link is read, and asks for nothing", () => {
    mockSuspend = true;
    renderFeed();
    expect(within(feedTable()).getByRole("link", { name: "BHP" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /^Notices by week over the last 30 days/ })).toBeInTheDocument();
    expect(screen.getByText("1–1 of 1")).toBeInTheDocument();
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("draws a shell's fallback as loading, with no outage and no count", () => {
    mockSuspend = true;
    renderFeed(feedPage({ ok: false, rows: [], total: 0, weeks: [] }));
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(screen.queryByText("0 notices")).toBeNull();
    expect(screen.queryByRole("img", { name: /^Notices by week/ })).toBeNull();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("answers a link that is not the default view with its own query, asked once", async () => {
    mockSearchParams = new URLSearchParams("event=ceased&stock=bhp");
    loadPage.mockResolvedValue(
      feedPage({
        query: { ...defaultNoticeQuery(), event: "ceased", stockCode: "BHP" },
        rows: [feedRow({ event: "ceased", votingPower: "under 5%" })],
      }),
    );
    renderFeed();
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(1));
    expect(loadPage.mock.calls[0]![0]).toMatchObject({ event: "ceased", stockCode: "BHP", windowDays: 30, cursor: "" });
    expect(await within(feedTable()).findByText("Ceased")).toBeInTheDocument();
    expect(select("event")).toHaveValue("ceased");
    expect(screen.getByLabelText("Stock")).toHaveValue("BHP");
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("asks for the link the reader moves to, and draws the answer", async () => {
    renderFeed();
    loadPage.mockResolvedValue(
      feedPage({
        query: { ...defaultNoticeQuery(), event: "decreased" },
        rows: [
          feedRow({
            holder: "Alpha Super",
            holderHref: null,
            event: "decreased",
            votingPower: "4.90%",
            change: "−0.31 pp",
          }),
        ],
        weeks: [],
      }),
    );
    moveTo("event=decreased");
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ event: "decreased", windowDays: 30, cursor: "" }));
    expect(await within(feedTable()).findByText("Decreased")).toBeInTheDocument();
    expect(within(feedTable()).getByText("Alpha Super")).toBeInTheDocument();
    // The change is drawn once: its own column from md, the line under the figure below it.
    expect(within(feedTable()).getAllByText("−0.31 pp")).toHaveLength(1);
    expect(screen.queryByRole("link", { name: "Vanguard Group" })).toBeNull();
  });

  it("writes a holder the reader picks into the link, asks for it, and shows an empty answer as a filter", async () => {
    renderFeed();
    loadPage.mockResolvedValue(
      feedPage({ query: { ...defaultNoticeQuery(), institutionSlug: "alpha-super" }, rows: [], total: 0, weeks: [] }),
    );
    fireEvent.change(select("holder"), { target: { value: "alpha-super" } });
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ institutionSlug: "alpha-super", cursor: "" }));
    expect(await screen.findByText("No notices read match these filters in the last 30 days.")).toBeInTheDocument();
    expect(window.location.search).toBe("?holder=alpha-super");
  });

  it("shows the outage line and no rows when the request fails, never the empty copy", async () => {
    renderFeed();
    loadPage.mockRejectedValue(new Error("network"));
    fireEvent.change(select("holder"), { target: { value: "alpha-super" } });
    expect(await screen.findByText(OUTAGE)).toBeInTheDocument();
    expect(screen.queryByRole("table", { name: TABLE_NAME })).toBeNull();
    expect(screen.queryByText(/No notices read match/)).toBeNull();
  });

  it("treats an answer that is not ok as an outage, not as an empty feed, even when the action gives a reason", async () => {
    renderFeed();
    loadPage.mockResolvedValue(feedPage({ ok: false, rows: [], total: 0, weeks: [] }));
    moveTo("window=7");
    expect(await screen.findByText(OUTAGE)).toBeInTheDocument();
    expect(screen.queryByText(/No notices read match/)).toBeNull();
  });

  it("draws a shell the server could not render as loading, with no outage and no zero, then asks once", async () => {
    loadPage.mockResolvedValue(feedPage());
    renderFeed(feedPage({ ok: false, rows: [], total: 0, weeks: [] }));
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(screen.queryByText("0 notices")).toBeNull();
    expect(screen.queryByRole("img", { name: /^Notices by week/ })).toBeNull();
    await act(async () => undefined);
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ windowDays: 30, cursor: "" }));
    expect(within(feedTable()).getByText("5.12%")).toBeInTheDocument();
    expect(screen.getByText("1–1 of 1")).toBeInTheDocument();
  });

  it("shows the outage for a shell whose one request failed", async () => {
    loadPage.mockRejectedValue(new Error("network"));
    renderFeed(feedPage({ ok: false, rows: [], total: 0, weeks: [] }));
    await act(async () => undefined);
    expect(screen.getByText(OUTAGE)).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledTimes(1);
  });

  it("says an answered empty result is a filter, in the window it was asked for", async () => {
    renderFeed();
    loadPage.mockResolvedValue(
      feedPage({ query: { ...defaultNoticeQuery(), windowDays: 7 }, rows: [], total: 0, weeks: [] }),
    );
    moveTo("window=7");
    expect(await screen.findByText("No notices read match these filters in the last 7 days.")).toBeInTheDocument();
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(screen.getByText("0 notices")).toBeInTheDocument();
  });

  it("says the all-notices window with neither a day count nor a start date, since the feed states none", async () => {
    renderFeed();
    loadPage.mockResolvedValue(
      feedPage({ query: { ...defaultNoticeQuery(), windowDays: 0 }, rows: [], total: 0, weeks: [] }),
    );
    moveTo("window=all");
    expect(await screen.findByText("No notices read match these filters.")).toBeInTheDocument();
    expect(select("window")).toHaveValue("0");
    expect(within(select("window")).getByRole("option", { name: "All notices" })).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ windowDays: 0 }));
  });

  it("keeps the rows dimmed and says it is an outage once a request has been in flight for ten seconds", async () => {
    jest.useFakeTimers();
    renderFeed();
    const pending = deferred<NoticeFeedPage>();
    loadPage.mockReturnValue(pending.promise);
    moveTo("event=ceased");
    act(() => {
      jest.advanceTimersByTime(OUTAGE_AFTER_MS - 1);
    });
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(feedTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(screen.getByText(OUTAGE)).toBeInTheDocument();
    expect(feedTable()).toBeInTheDocument();
    await act(async () => {
      pending.resolve(feedPage({ query: { ...defaultNoticeQuery(), event: "ceased" }, rows: [feedRow({ event: "ceased" })] }));
    });
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(feedTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });

  it("lets only the newest answer write the rows when two changes race", async () => {
    renderFeed();
    const first = deferred<NoticeFeedPage>();
    const second = deferred<NoticeFeedPage>();
    loadPage.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    moveTo("event=ceased");
    moveTo("event=decreased");
    await act(async () => {
      second.resolve(
        feedPage({
          query: { ...defaultNoticeQuery(), event: "decreased" },
          rows: [feedRow({ holder: "Newest Holder", holderHref: null, event: "decreased" })],
        }),
      );
    });
    await act(async () => {
      first.resolve(
        feedPage({
          query: { ...defaultNoticeQuery(), event: "ceased" },
          rows: [feedRow({ holder: "Stale Holder", holderHref: null, event: "ceased" })],
        }),
      );
    });
    expect(within(feedTable()).getByText("Newest Holder")).toBeInTheDocument();
    expect(screen.queryByText("Stale Holder")).toBeNull();
  });

  it("appends the next page when the reader asks for more, with the cursor the page gave", async () => {
    const cursor = "2026-10-01|https://www.asx.com.au/notices/cba-1.pdf";
    renderFeed(feedPage({ nextCursor: cursor, total: 2 }));
    loadPage.mockResolvedValue(
      feedPage({
        rows: [
          feedRow({
            released: "2026-10-01",
            code: "CBA",
            companyName: "Commonwealth Bank",
            holder: "Alpha Super",
            holderHref: null,
            url: "https://www.asx.com.au/notices/cba-1.pdf",
          }),
        ],
        total: 2,
        nextCursor: "",
        weeks: [],
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await within(feedTable()).findByRole("link", { name: "CBA" })).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ cursor }));
    expect(within(feedTable()).getByRole("link", { name: "BHP" })).toBeInTheDocument();
    expect(screen.getByText("1–2 of 2")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).toBeNull();
    expect(window.location.search).toBe("");
  });

  it("keeps the rows and the Show more button when the next page fails, with the outage beside them", async () => {
    renderFeed(feedPage({ nextCursor: "2026-10-01|https://www.asx.com.au/notices/cba-1.pdf", total: 2 }));
    loadPage.mockRejectedValue(new Error("network"));
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByText(OUTAGE)).toBeInTheDocument();
    expect(within(feedTable()).getByRole("link", { name: "BHP" })).toBeInTheDocument();
    expect(screen.getByText("1–1 of 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show more" })).toBeEnabled();
  });

  it("applies the stock box on submit as an ASX code: upper case, letters and digits, six at most", async () => {
    renderFeed();
    loadPage.mockResolvedValue(
      feedPage({ query: { ...defaultNoticeQuery(), stockCode: "BHPX9Z" }, rows: [], total: 0, weeks: [] }),
    );
    const input = screen.getByLabelText("Stock");
    fireEvent.change(input, { target: { value: " bh p-x9z " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ stockCode: "BHPX9Z" })));
    expect(window.location.search).toBe("?stock=BHPX9Z");
  });

  it("lists the registry's holders by name in the holder select", () => {
    renderFeed();
    const names = Array.from(select("holder").options).map((option) => option.textContent);
    expect(names).toEqual(["Any holder", "Alpha Super", "Zeta Fund"]);
  });

  it("draws the window, event and kind as selects that keep the other filters when they change", () => {
    jest.useFakeTimers();
    mockSearchParams = new URLSearchParams("stock=BHP");
    loadPage.mockReturnValue(new Promise(() => undefined));
    renderFeed();
    expect(select("window")).toHaveValue("30");
    expect(Array.from(select("window").options).map((option) => option.textContent)).toEqual([
      "7 days",
      "30 days",
      "90 days",
      "365 days",
      "All notices",
    ]);
    expect(select("event")).toHaveValue("");
    expect(within(select("event")).getByRole("option", { name: "Any event" })).toBeInTheDocument();
    expect(within(select("kind")).getByRole("option", { name: "Super funds" })).toBeInTheDocument();
    fireEvent.change(select("window"), { target: { value: "7" } });
    expect(loadPage).toHaveBeenLastCalledWith(expect.objectContaining({ windowDays: 7, stockCode: "BHP", cursor: "" }));
    fireEvent.change(select("event"), { target: { value: "ceased" } });
    expect(loadPage).toHaveBeenLastCalledWith(expect.objectContaining({ event: "ceased", stockCode: "BHP", windowDays: 7 }));
    fireEvent.change(select("kind"), { target: { value: "super_fund" } });
    expect(loadPage).toHaveBeenLastCalledWith(expect.objectContaining({ kind: "super_fund", event: "ceased", stockCode: "BHP" }));
  });

  it("draws no weekly counts for a window wider than the activity serves", async () => {
    mockSearchParams = new URLSearchParams("window=365");
    loadPage.mockResolvedValue(
      feedPage({ query: { ...defaultNoticeQuery(), windowDays: 365 }, rows: [feedRow()], weeks: [] }),
    );
    renderFeed();
    // The default view's bars are on the screen until the 365-day answer lands.
    expect(screen.getByRole("img", { name: /^Notices by week/ })).toBeInTheDocument();
    await act(async () => undefined);
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ windowDays: 365 }));
    expect(screen.queryByRole("img", { name: /^Notices by week/ })).toBeNull();
  });

  it("keeps the rows and draws no weekly counts when the activity did not answer, with no outage", () => {
    renderFeed(feedPage({ activityOk: false, weeks: [] }));
    expect(screen.queryByRole("img", { name: /^Notices by week/ })).toBeNull();
    expect(screen.queryByText(OUTAGE)).toBeNull();
    expect(feedTable()).toBeInTheDocument();
  });

  it("prints n/a in the change column when the notice has no earlier figure, named beside it on a phone", () => {
    renderFeed(feedPage({ rows: [feedRow({ change: "" })], weeks: [] }));
    const row = within(feedTable()).getByRole("link", { name: "BHP" }).closest("tr")!;
    // Below md the header is for a screen reader only, so the cell names itself: "Change n/a" on a phone.
    // The name is decorative (aria-hidden), since the header already names the column for a screen reader.
    expect(row.children[5]).toHaveTextContent(/^Change n\/a$/);
    expect(row.children[5].querySelector('[aria-hidden="true"]')).toHaveClass("md:hidden");
  });

  it("is never red or green: no event, change or count takes a market colour", () => {
    const { container } = renderFeed(
      feedPage({
        rows: [
          feedRow({ event: "ceased", votingPower: "under 5%", change: "−1.00 pp" }),
          feedRow({ event: "increased", change: "+1.14 pp", url: "https://www.asx.com.au/notices/bhp-2.pdf" }),
        ],
        total: 2,
      }),
    );
    expect(container.innerHTML).not.toMatch(
      /\b(?:text|bg|border|fill|stroke|ring|decoration)-(?:red|green)\b|#EF4444|#22C55E|#F87171|#4ADE80/i,
    );
  });

  it("keeps a holder the registry does not list as an option under its slug, and asks for it", async () => {
    mockSearchParams = new URLSearchParams("holder=vanguard");
    loadPage.mockResolvedValue(
      feedPage({ query: { ...defaultNoticeQuery(), institutionSlug: "vanguard" }, rows: [], total: 0, weeks: [] }),
    );
    renderFeed();
    // The select shows the filter the feed runs, so a reader never sees "Any holder" over a filtered list.
    expect(select("holder")).toHaveValue("vanguard");
    expect(within(select("holder")).getByRole("option", { name: "vanguard" })).toBeInTheDocument();
    expect(await screen.findByText("No notices read match these filters in the last 30 days.")).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ institutionSlug: "vanguard" }));
    expect(select("holder")).toHaveValue("vanguard");
  });

  it("sends a holder to the API when the registry is empty, and shows the refusal as the outage", async () => {
    mockSearchParams = new URLSearchParams("holder=vanguard");
    loadPage.mockResolvedValue(feedPage({ ok: false, rows: [], total: 0, weeks: [] }));
    renderFeed(feedPage(), []);
    await waitFor(() =>
      expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ institutionSlug: "vanguard" })),
    );
    expect(await screen.findByText(OUTAGE)).toBeInTheDocument();
    expect(screen.queryByText(/No notices read match/)).toBeNull();
  });

  it("reads the industry and the dates from the link, and asks the server for them", () => {
    jest.useFakeTimers();
    mockSearchParams = new URLSearchParams("industry=Energy&since=2026-08-01&until=2026-10-31");
    loadPage.mockReturnValue(new Promise(() => undefined));
    renderFeed();
    expect(loadPage).toHaveBeenCalledTimes(1);
    expect(loadPage).toHaveBeenCalledWith(
      expect.objectContaining({ industry: "Energy", since: "2026-08-01", until: "2026-10-31", windowDays: 0 }),
    );
  });

  it("shows a date range as the window's selected option, and a window choice clears the range", () => {
    jest.useFakeTimers();
    mockSearchParams = new URLSearchParams("since=2026-08-01&until=2026-10-31");
    loadPage.mockReturnValue(new Promise(() => undefined));
    renderFeed(feedPage({ query: { ...defaultNoticeQuery(), windowDays: 0, since: "2026-08-01", until: "2026-10-31" } }));
    expect(select("window")).toHaveValue("dates");
    expect(within(select("window")).getByRole("option", { name: "Date range" })).toBeInTheDocument();
    expect(screen.getByText("Dates: 2026-08-01 to 2026-10-31")).toBeInTheDocument();
    fireEvent.change(select("window"), { target: { value: "90" } });
    expect(loadPage).toHaveBeenLastCalledWith(
      expect.objectContaining({ windowDays: 90, since: "", until: "" }),
    );
  });

  it("names a range with one side alone as from or until", () => {
    jest.useFakeTimers();
    mockSearchParams = new URLSearchParams("since=2026-08-01");
    loadPage.mockReturnValue(new Promise(() => undefined));
    renderFeed(feedPage({ query: { ...defaultNoticeQuery(), windowDays: 0, since: "2026-08-01" } }));
    expect(within(select("window")).getByRole("option", { name: "Date range" })).toBeInTheDocument();
    expect(screen.getByText("Dates: From 2026-08-01")).toBeInTheDocument();
  });

  it("keeps the window beside an industry filter, which clears only the industry and keeps the stock", () => {
    jest.useFakeTimers();
    mockSearchParams = new URLSearchParams("industry=Energy&stock=BHP");
    loadPage.mockReturnValue(new Promise(() => undefined));
    renderFeed(feedPage({ query: { ...defaultNoticeQuery(), industry: "Energy", stockCode: "BHP" } }));
    expect(select("window")).toHaveValue("30");
    const industry = within(group("Filtered by")).getByRole("link", { name: "Industry: Energy, clear filter" });
    expect(industry).toHaveAttribute("href", `${BASE}?stock=BHP`);
    expect(industry).not.toHaveAttribute("aria-current");
  });

  // A filter change rewrites the feed's own parameters in the link, once each, and leaves a foreign one alone.
  it("writes the industry and the dates into the link once each on a filter change, and keeps utm_source", () => {
    window.history.replaceState(null, "", `${BASE}?utm_source=newsletter`);
    mockSearchParams = new URLSearchParams("industry=Energy&since=2026-08-01&until=2026-10-31&utm_source=newsletter");
    loadPage.mockReturnValue(new Promise(() => undefined));
    renderFeed(feedPage({ query: { ...defaultNoticeQuery(), windowDays: 0, industry: "Energy", since: "2026-08-01", until: "2026-10-31" } }));
    fireEvent.change(select("holder"), { target: { value: "alpha-super" } });
    const written = new URLSearchParams(window.location.search);
    expect(written.get("utm_source")).toBe("newsletter");
    expect(written.getAll("industry")).toEqual(["Energy"]);
    expect(written.getAll("since")).toEqual(["2026-08-01"]);
    expect(written.getAll("until")).toEqual(["2026-10-31"]);
    expect(written.get("holder")).toBe("alpha-super");
  });

  it("keeps a parameter the feed does not own when a filter changes", () => {
    window.history.replaceState(null, "", `${BASE}?utm_source=newsletter`);
    loadPage.mockReturnValue(new Promise(() => undefined));
    renderFeed();
    fireEvent.change(select("holder"), { target: { value: "alpha-super" } });
    expect(window.location.search).toBe("?utm_source=newsletter&holder=alpha-super");
  });

  it("draws Show more disabled in the server's fallback, so the line keeps its height when the island takes over", () => {
    mockSuspend = true;
    renderFeed(feedPage({ nextCursor: "2026-10-01|https://www.asx.com.au/notices/cba-1.pdf", total: 2 }));
    expect(screen.getByRole("button", { name: "Show more" })).toBeDisabled();
    expect(loadPage).not.toHaveBeenCalled();
  });

  it("says the wait in the list's place while a change has no rows to dim", () => {
    renderFeed(feedPage({ rows: [], total: 0, weeks: [] }));
    loadPage.mockReturnValue(new Promise(() => undefined));
    moveTo("event=ceased");
    const wait = screen.getByRole("status", { name: "Loading" });
    expect(wait).toHaveAttribute("aria-busy", "true");
    expect(wait).toHaveTextContent("Loading…");
  });

  it("draws each value once, and stacks a phone row by order: the date under the event, the holder under the stock", () => {
    renderFeed(feedPage({ rows: [feedRow({ event: "decreased", change: "−0.31 pp" })], weeks: [] }));
    const table = feedTable();
    expect(within(table).getAllByText("−0.31 pp")).toHaveLength(1);
    expect(within(table).getAllByText("Vanguard Group")).toHaveLength(1);
    expect(within(table).getAllByText("2026-10-16")).toHaveLength(1);
    // The row folds at md, and the cells follow it. A row folded at sm would be a table row from 640 px while its cells
    // kept the phone's full widths, so the feed would break from 640 px to 767 px.
    const row = within(table).getByRole("link", { name: "BHP" }).closest("tr")!;
    expect(row).toHaveClass("flex", "flex-wrap", "md:table-row", "md:py-0");
    expect(row).not.toHaveClass("sm:table-row");
    // The DOM keeps the table's column order: below md `order` stacks the cells, from md they are the columns again.
    const cells = Array.from(row.children);
    expect(cells[0]).toHaveClass("order-2", "md:order-none"); // Released
    expect(cells[1]).toHaveClass("order-1", "md:order-none"); // Event
    expect(cells[2]).toHaveClass("order-3", "md:order-none"); // Stock
    expect(cells[3]).toHaveClass("order-4", "md:order-none"); // Holder
    expect(cells[4]).toHaveClass("order-5", "md:order-none"); // Voting power
    expect(cells[5]).toHaveClass("order-6", "md:order-none", "whitespace-nowrap"); // Change: its figure and unit stay on one line
    expect(cells[6]).toHaveClass("order-5", "md:order-none"); // Notice on ASX, beside the voting power
    // Each phone line takes the row's width, except the voting power and its link, which share a line: the figure
    // keeps its content width, so it cannot sit at zero width beside the holder. jsdom draws no layout, so the
    // 360 px band is measured in a browser; these classes are what that measure depends on.
    expect(cells[1]).toHaveClass("w-full", "md:w-auto"); // Event: its own line, so the date below cannot share it
    expect(cells[4]).toHaveClass("flex-auto");
    expect(cells[4]).not.toHaveClass("flex-1");
    expect(cells[6]).toHaveClass("pr-1"); // the glyph's hit area overhangs its flush-right icon by 4 px
    // Below md the headers are for a screen reader only: the stacked row's own words say what each value is.
    expect(table.querySelector("thead")).toHaveClass("sr-only", "md:not-sr-only");
  });

  it("draws a long company name from lg as a box that truncates, so it cannot widen the Stock column", () => {
    renderFeed(feedPage({ rows: [feedRow({ companyName: "Commonwealth Bank of Australia" })], weeks: [] }));
    const name = within(feedTable()).getByText("Commonwealth Bank of Australia");
    // Not from md, and capped at 8 rem until xl: measured, a 12 rem name at lg made the table 54 px wider than a
    // signed-in reader's 736 px. An inline name cannot truncate at all (overflow does not apply to inline boxes).
    expect(name).toHaveClass("hidden", "lg:inline-block", "lg:max-w-[8rem]", "lg:truncate", "xl:max-w-[12rem]");
    expect(name).not.toHaveClass("md:inline");
  });

  it("pads a stacked phone cell flush across and 8 px a side from md, 12 px from xl, as the register list does", () => {
    renderFeed();
    const cells = Array.from(within(feedTable()).getByRole("link", { name: "BHP" }).closest("tr")!.children);
    // A phone's cells are flush across, with a hair up and down. From md the padding comes back at the register list's
    // 8 px, not the 16 px that squeezed the holder's column at 768 px.
    expect(cells[1]).toHaveClass("p-0", "py-0.5", "md:px-2", "md:py-4", "xl:px-3");
    expect(cells[1]).not.toHaveClass("md:p-4");
  });

  it("keeps a space between a stock's code and its company name, so a line can break between them", () => {
    renderFeed(feedPage({ rows: [feedRow({ companyName: "Commonwealth Bank of Australia" })], weeks: [] }));
    const cell = within(feedTable()).getByRole("link", { name: "BHP" }).closest("td")!;
    expect(cell.textContent).toBe("BHP Commonwealth Bank of Australia");
  });

  it("prints no stray space after a stock's code when the notice names no company", () => {
    renderFeed(feedPage({ rows: [feedRow({ companyName: "" })], weeks: [] }));
    const cell = within(feedTable()).getByRole("link", { name: "BHP" }).closest("td")!;
    expect(cell.textContent).toBe("BHP");
  });

  it("clears the outage timer when the feed leaves the screen", () => {
    jest.useFakeTimers();
    renderFeed();
    loadPage.mockReturnValue(new Promise(() => undefined));
    moveTo("event=ceased");
    expect(jest.getTimerCount()).toBeGreaterThan(0);
    view.unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each([
    ["ASX:bhp", "BHP"],
    ["cba.ax", "CBA"],
  ])("reads the box's %s as the code %s, and has no length cap to cut it short", async (typed, code) => {
    renderFeed();
    loadPage.mockResolvedValue(
      feedPage({ query: { ...defaultNoticeQuery(), stockCode: code }, rows: [], total: 0, weeks: [] }),
    );
    const input = screen.getByLabelText("Stock");
    expect(input).not.toHaveAttribute("maxlength");
    fireEvent.change(input, { target: { value: typed } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ stockCode: code })));
    expect(window.location.search).toBe(`?stock=${code}`);
  });

  it("asks for nothing under StrictMode while the link is the default view the server drew", () => {
    renderFeedStrict();
    expect(loadPage).not.toHaveBeenCalled();
    expect(feedTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });

  it("asks a non-default link again after StrictMode's remount, and draws the rows it answers", async () => {
    mockSearchParams = new URLSearchParams("event=ceased");
    loadPage.mockResolvedValue(
      feedPage({
        query: { ...defaultNoticeQuery(), event: "ceased" },
        rows: [feedRow({ event: "ceased", votingPower: "under 5%" })],
      }),
    );
    renderFeedStrict();
    expect(await within(feedTable()).findByText("Ceased")).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ event: "ceased" }));
    expect(feedTable().closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });

  it("asks a shell again after StrictMode's remount, and draws the rows it answers", async () => {
    loadPage.mockResolvedValue(feedPage());
    renderFeedStrict(feedPage({ ok: false, rows: [], total: 0, weeks: [] }));
    const table = await screen.findByRole("table", { name: TABLE_NAME });
    expect(within(table).getByText("5.12%")).toBeInTheDocument();
    expect(loadPage).toHaveBeenCalledWith(expect.objectContaining({ windowDays: 30, cursor: "" }));
    expect(table.closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
  });
});

describe("the feed's toolbar (spec 14.9)", () => {
  it("draws the window, event, kind, holder and stock as one labelled row, with no uppercase label", () => {
    renderFeed();
    const rows = document.querySelectorAll("[data-toolbar]");
    expect(rows).toHaveLength(1);
    const row = within(rows[0] as HTMLElement);
    for (const name of ["Window", "Event", "Kind", "Holder"]) {
      expect(row.getByRole("combobox", { name })).toBeInTheDocument();
    }
    expect(row.getByLabelText("Stock")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Window" })).toBeNull();
    expect(screen.getByText("Window", { selector: "span" })).not.toHaveClass("uppercase");
  });

  it("names the kinds in short form and caps the kind and holder selects, so the row fits one line at 1440", () => {
    // The row's width is an estimate (IBM Plex Mono 12px, 7.2 px a character, against the 1016 px column):
    // the widest kind name is 15 characters ("Active managers"), and the holder and kind selects carry the 9rem cap.
    renderFeed();
    const row = within(document.querySelector("[data-toolbar]") as HTMLElement);
    const kind = row.getByRole("combobox", { name: "Kind" }) as HTMLSelectElement;
    for (const option of Array.from(kind.options)) expect(option.textContent!.length).toBeLessThanOrEqual(15);
    expect(kind.className).toContain("max-w-[9rem]");
    expect(row.getByRole("combobox", { name: "Holder" }).className).toContain("max-w-[9rem]");
    expect(row.getByLabelText("Stock").className).toContain("w-20");
  });

  it("writes a date range as a caption, the window select saying only 'Date range'", () => {
    mockSearchParams = new URLSearchParams("since=2026-08-01&until=2026-10-31");
    renderFeed(feedPage({ query: { ...defaultNoticeQuery(), since: "2026-08-01", until: "2026-10-31" } }));
    expect(select("window").options[0]).toHaveTextContent("Date range");
    expect(screen.getByText("Dates: 2026-08-01 to 2026-10-31")).toBeInTheDocument();
  });
});
