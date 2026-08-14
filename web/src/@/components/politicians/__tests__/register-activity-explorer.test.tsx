/**
 * The /politicians/changes island names a real person on every row, so the
 * things this file pins are editorial as much as behavioural:
 *
 *   - AN EMPTY FEED MEANS TWO OPPOSITE THINGS. With a filter set AND a response
 *     that answered it is an honest answer about the filter; with no filter, or
 *     with a request that never answered, it can only be our own outage — and
 *     "no register events match" would then read as an absence claim about every
 *     member that filter covers. The action reports which case it is (`ok`),
 *     because both arrive here as zero rows.
 *   - THE RAILS ARE NOT THE FILTER. The aggregate rpc takes only a window, so
 *     the three rails describe the whole register over that window. Rendering
 *     them under a member filter without saying so would attribute
 *     parliament-wide counts to one named member.
 *   - THE WINDOW IN THE COPY IS THE RESPONSE'S. The backend rounds a request up
 *     (45 -> 90); captioning the request puts "45 days" over 90 days of events.
 *   - A SLOW RESPONSE MUST NOT WIN. Two quick filter changes race, and if the
 *     older lands the page shows events matching neither control.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  RegisterActivityExplorer,
  type ActivityEventRow,
  type RegisterActivityPage,
  type RegisterActivityQuery,
} from "../register-activity-explorer";

const searchPoliticiansMock = jest.fn();

jest.mock("@/lib/politics/politician-search", () => ({
  searchPoliticians: (...args: unknown[]) => searchPoliticiansMock(...args),
}));

function baseQuery(overrides: Partial<RegisterActivityQuery> = {}): RegisterActivityQuery {
  return {
    windowDays: 90,
    kind: "",
    chamber: "",
    partyAb: "",
    itemNo: 0,
    politicianSlug: "",
    limit: 100,
    offset: 0,
    ...overrides,
  };
}

function event(overrides: Partial<ActivityEventRow> = {}): ActivityEventRow {
  return {
    id: "a-member-0",
    changedOn: "2026-07-02",
    dateLabel: "2 Jul 2026",
    kind: "added",
    slug: "a-member",
    displayName: "A Member",
    partyAb: "ALP",
    itemNo: 1,
    itemLabel: "Shareholdings",
    holderLabel: "Spouse/partner",
    declaredText: "ABC Ltd",
    stockCode: "ABC",
    companyName: "ABC Ltd",
    entityKindLabel: "",
    ...overrides,
  };
}

function page(overrides: Partial<RegisterActivityPage> = {}): RegisterActivityPage {
  return {
    query: baseQuery(),
    windowDays: 90,
    events: [event()],
    total: 1,
    weeks: [{ weekStart: "2026-06-29", addedCount: 4, removedCount: 1 }],
    // Deliberately NOT the member in the feed: the rails describe the whole
    // register over the window, and a fixture that reused the feed's member
    // would hide a query that accidentally read one for the other.
    activeMembers: [
      { slug: "c-member", displayName: "C Member", partyAb: "GRN", eventCount: 5 },
    ],
    newlyDeclaredCompanies: [
      {
        stockCode: "ABC",
        companyName: "ABC Ltd",
        firstDeclaredOn: "2026-07-02",
        firstDeclaredLabel: "2 Jul 2026",
        declarerCount: 2,
      },
    ],
    declarerCountChanges: [
      { stockCode: "XYZ", companyName: "XYZ Ltd", declarersNow: 5, declarersAtWindowStart: 3 },
    ],
    undatedCurrentCount: 1234,
    // The strip's own totals under the page's filters, served BY the aggregate
    // rpc — never counted from `events`, which is one page of a paginated feed.
    filteredEventCount: 5,
    filteredMemberCount: 3,
    ok: true,
    railsOk: true,
    ...overrides,
  };
}

/**
 * What the action ACTUALLY produces when the aggregate rpc does not answer:
 * every rails-derived array empty and every rails-derived count zero. A fixture
 * that leaves them populated tests a state that cannot occur, and lets a page
 * that publishes zeros during an outage pass.
 */
function railsDown(overrides: Partial<RegisterActivityPage> = {}): RegisterActivityPage {
  return page({
    railsOk: false,
    weeks: [],
    activeMembers: [],
    newlyDeclaredCompanies: [],
    declarerCountChanges: [],
    undatedCurrentCount: 0,
    filteredEventCount: 0,
    filteredMemberCount: 0,
    ...overrides,
  });
}

describe("register activity explorer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    searchPoliticiansMock.mockResolvedValue({ hits: [] });
  });

  it("renders the server's first page, grouped by day", () => {
    render(<RegisterActivityExplorer initialPage={page()} loadPage={jest.fn()} />);

    expect(screen.getByRole("heading", { name: /additions and removals/i })).toBeInTheDocument();
    // The day heading. (The same date also appears in the "first declared" rail,
    // which is why this is scoped to the heading rather than to the text.)
    expect(screen.getByRole("heading", { level: 3, name: "2 Jul 2026" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "A Member" })).toHaveAttribute(
      "href",
      "/politicians/a-member",
    );
    // The row's micro-label. (The strip's legend also says "added", with its
    // own count beside it.)
    expect(screen.getAllByText("added").length).toBeGreaterThan(0);
    expect(screen.getByText("Shareholdings")).toBeInTheDocument();
    expect(screen.getByText("Spouse/partner")).toBeInTheDocument();
  });

  it("says how many dated events the window holds, and what it excludes", () => {
    render(<RegisterActivityExplorer initialPage={page()} loadPage={jest.fn()} />);

    // The response's own filtered totals, not a count of the rendered rows.
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent(/5\s*dated register events in the last 90 days/i);
    expect(line).toHaveTextContent(/from\s*3\s*members across all members/i);
    // The rows a dated timeline cannot hold are STATED, never silently absent.
    expect(line).toHaveTextContent(/1,234\s*currently-declared entries state no start date/i);
  });

  it("states the member count the RESPONSE gives, not the one the page can see", () => {
    // One rendered row, 42 matching events, 9 distinct members behind them: a
    // count taken from the rows would say "1 member" and shrink further on the
    // next page of the same filter.
    render(
      <RegisterActivityExplorer
        initialPage={page({ total: 42, filteredEventCount: 42, filteredMemberCount: 9 })}
        loadPage={jest.fn()}
      />,
    );

    const line = screen.getByRole("status");
    expect(line).toHaveTextContent(/42\s*dated register events/);
    expect(line).toHaveTextContent(/from\s*9\s*members/);
    // And no hedge: the figure is exact, so it is not qualified as a floor.
    expect(line).not.toHaveTextContent(/in this view/i);
  });

  it("captions the strip with the filter scope the buckets were narrowed by", () => {
    render(
      <RegisterActivityExplorer
        initialPage={page({ query: baseQuery({ politicianSlug: "a-member" }) })}
        loadPage={jest.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/under the filters set above/i);
    // The chart carries the same scope, so a screen reader is not told the
    // parliament's counts where a sighted reader is told one member's.
    //
    // NAMED, not `getByRole("img")` bare: since the iconography wave every
    // <PartyMark> in the feed is a labelled `role="img"` too, so a bare query
    // matches the chart AND every party mark beside a member's name. Asking for
    // the chart by its own accessible name is what this assertion always meant.
    expect(
      screen
        .getByRole("img", { name: /Register events by week/i })
        .getAttribute("aria-label"),
    ).toContain("under the filters set above");
  });

  it("passes the island's current filters to the action, not just the window", async () => {
    const loadPage = jest.fn().mockResolvedValue(page());
    render(
      <RegisterActivityExplorer
        initialPage={page({ query: baseQuery({ partyAb: "ALP" }) })}
        loadPage={loadPage}
        partyOptions={["ALP", "LP"]}
      />,
    );

    fireEvent.change(screen.getByLabelText("Chamber"), { target: { value: "senate" } });

    await waitFor(() =>
      expect(loadPage).toHaveBeenCalledWith(
        expect.objectContaining({ partyAb: "ALP", chamber: "senate" }),
      ),
    );
  });

  it("captions the window the RESPONSE reported, not the one requested", () => {
    // The action asked for 45; the backend served 90 and said so.
    render(
      <RegisterActivityExplorer
        initialPage={page({ query: baseQuery({ windowDays: 90 }), windowDays: 90 })}
        loadPage={jest.fn()}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/the last 90 days/);
    expect(screen.queryByText(/45 days/)).toBeNull();
  });

  it("re-queries through the action when a filter changes", async () => {
    const loadPage = jest.fn().mockResolvedValue(
      page({
        query: baseQuery({ windowDays: 30 }),
        windowDays: 30,
        events: [event({ id: "b-0", displayName: "B Member", slug: "b-member" })],
      }),
    );
    render(<RegisterActivityExplorer initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Window"), { target: { value: "30" } });

    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(1));
    expect(loadPage).toHaveBeenCalledWith(
      expect.objectContaining({ windowDays: 30, offset: 0 }),
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "B Member" })).toBeInTheDocument(),
    );
    expect(screen.getByRole("status")).toHaveTextContent(/the last 30 days/);
  });

  it("resets the offset when a filter changes", async () => {
    const loadPage = jest.fn().mockResolvedValue(page());
    render(
      <RegisterActivityExplorer
        initialPage={page({ query: baseQuery({ offset: 200 }) })}
        loadPage={loadPage}
      />,
    );

    fireEvent.change(screen.getByLabelText("Register category"), { target: { value: "3" } });

    await waitFor(() => expect(loadPage).toHaveBeenCalledWith(
      expect.objectContaining({ itemNo: 3, offset: 0 }),
    ));
  });

  it("composes two in-flight changes to DIFFERENT controls, and keeps both", async () => {
    // The defect this pins: requests were built from the last RESPONSE's echoed
    // query, so a second change made before the first landed carried the OLD
    // value of the first control — and the first control then snapped back to it
    // when the response arrived. Two changes to the SAME control cannot see it,
    // because the newer value overwrites the older either way.
    let resolveFirst: (value: RegisterActivityPage) => void = () => {};
    const first = new Promise<RegisterActivityPage>((resolve) => {
      resolveFirst = resolve;
    });
    const loadPage = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockImplementationOnce(async (query: RegisterActivityQuery) =>
        page({
          query,
          events: [event({ id: "second", displayName: "Second Result" })],
        }),
      );

    render(<RegisterActivityExplorer initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "added" } });
    fireEvent.change(screen.getByLabelText("Chamber"), { target: { value: "senate" } });

    // The SECOND request carries the first control's selection too.
    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(2));
    expect(loadPage.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ kind: "added", chamber: "senate" }),
    );

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Second Result" })).toBeInTheDocument(),
    );
    // …and neither control snaps back.
    expect(screen.getByLabelText("Event")).toHaveValue("added");
    expect(screen.getByLabelText("Chamber")).toHaveValue("senate");

    // The stale answer lands late and must be ignored entirely.
    resolveFirst(
      page({
        query: baseQuery({ kind: "added" }),
        events: [event({ id: "first", displayName: "Stale Result" })],
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Second Result" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("Stale Result")).toBeNull();
    expect(screen.getByLabelText("Chamber")).toHaveValue("senate");
  });

  it("words an outage as an outage, never as an empty filter", () => {
    render(
      <RegisterActivityExplorer
        initialPage={page({ ok: false, events: [], total: 0 })}
        loadPage={jest.fn()}
      />,
    );

    expect(screen.getByText(/this feed is unavailable right now/i)).toBeInTheDocument();
    expect(screen.getByText(/nothing here is missing from the register/i)).toBeInTheDocument();
    expect(screen.queryByText(/no register events match/i)).toBeNull();
  });

  it("treats an unfiltered empty feed as an outage, by arithmetic", () => {
    render(
      <RegisterActivityExplorer
        initialPage={page({ ok: true, events: [], total: 0 })}
        loadPage={jest.fn()}
      />,
    );

    expect(screen.getByText(/this feed is unavailable right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/no register events match/i)).toBeNull();
  });

  it("says an empty FILTER is a filter, and says so about the filter", () => {
    render(
      <RegisterActivityExplorer
        initialPage={page({
          ok: true,
          events: [],
          total: 0,
          query: baseQuery({ politicianSlug: "a-member" }),
        })}
        loadPage={jest.fn()}
      />,
    );

    const empty = screen.getByText(/no register events match these filters/i);
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent(/not a statement about anyone/i);
  });

  it("keeps the feed when only the rails are down", () => {
    render(<RegisterActivityExplorer initialPage={railsDown()} loadPage={jest.fn()} />);

    expect(screen.getByText(/weekly counts are unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "A Member" })).toBeInTheDocument();
  });

  it("publishes no rails-derived number or absence during a rails outage", () => {
    const { container } = render(
      <RegisterActivityExplorer initialPage={railsDown()} loadPage={jest.fn()} />,
    );
    const text = container.textContent ?? "";

    // Not one zero, and not one absence claim about parliament: every one of
    // these sentences would be OUR downtime published as a fact about members.
    expect(text).not.toMatch(/0 dated register events/i);
    expect(text).not.toMatch(/no dated events in this window/i);
    expect(text).not.toMatch(/no company was first declared/i);
    expect(text).not.toMatch(/count changed on a dated basis/i);
    // Each rail says the same thing instead: this is our end.
    expect(screen.getAllByText(/this list is unavailable right now/i)).toHaveLength(3);
    // And the count line is gone rather than zeroed.
    expect(screen.queryByText(/dated register events in the last/i)).toBeNull();
  });

  it("states that the rails describe the window rather than the filter", () => {
    render(
      <RegisterActivityExplorer
        initialPage={page({ query: baseQuery({ politicianSlug: "a-member" }) })}
        loadPage={jest.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: /most dated register events, the last 90 days/i }),
    ).toBeInTheDocument();
    const note = screen.getByText(/not narrowed by the filters above/i);
    expect(note).toBeInTheDocument();
    // The note governs three lists, so it is read BEFORE them — a scope note
    // beneath them arrives after the misreading it exists to prevent.
    expect(
      note.compareDocumentPosition(
        screen.getByRole("heading", { name: /most dated register events/i }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // …and it does not overclaim: these measures exclude undated declarations,
    // so they are not "the whole register".
    expect(note).toHaveTextContent(/dated declarations across all members/i);
    expect(note.textContent).not.toMatch(/whole register/i);
  });

  it("labels both rails' member counts as the one dated measure", () => {
    render(<RegisterActivityExplorer initialPage={page()} loadPage={jest.fn()} />);

    // Two member counts for a company on one page: unlabelled, they read as two
    // measures that disagree.
    expect(screen.getByText(/^2 members with dated declarations$/)).toBeInTheDocument();
    expect(
      screen.getByText(/\+2 members with dated declarations \(3 → 5\)/),
    ).toBeInTheDocument();
  });

  it("filters to a member from the keyboard alone", async () => {
    searchPoliticiansMock.mockResolvedValue({
      hits: [
        { slug: "b-member", display_name: "B Member" },
        { slug: "d-member", display_name: "D Member" },
      ],
    });
    const loadPage = jest.fn().mockResolvedValue(
      page({ query: baseQuery({ politicianSlug: "d-member" }) }),
    );
    render(<RegisterActivityExplorer initialPage={page()} loadPage={loadPage} />);

    const input = screen.getByLabelText("Member");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Member" } });

    const listbox = await screen.findByRole("listbox", { name: "Member results" });
    expect(input).toHaveAttribute("aria-expanded", "true");
    // The options are options, not buttons inside options. (They arrive after the
    // debounce; the list opens first, saying so.)
    await screen.findByRole("option", { name: "B Member" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);
    // Nothing is preselected, so a bare Enter chooses nobody.
    fireEvent.keyDown(input, { key: "Enter" });
    expect(loadPage).not.toHaveBeenCalled();

    // Up from nothing wraps to the LAST member.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    const options = within(listbox).getAllByRole("option");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[1]?.id);

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(within(listbox).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "ArrowUp" });

    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(loadPage).toHaveBeenCalledWith(
        expect.objectContaining({ politicianSlug: "d-member", offset: 0 }),
      ),
    );
    // Focus lands on the chip that describes the selection, never on <body>.
    const clear = await screen.findByRole("button", { name: "Clear member" });
    await waitFor(() => expect(clear).toHaveFocus());
  });

  it("filters to a member with the pointer, on mousedown", async () => {
    searchPoliticiansMock.mockResolvedValue({
      hits: [{ slug: "b-member", display_name: "B Member" }],
    });
    const loadPage = jest.fn().mockResolvedValue(
      page({ query: baseQuery({ politicianSlug: "b-member" }) }),
    );
    render(<RegisterActivityExplorer initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Member"), { target: { value: "Member" } });

    const option = await screen.findByRole("option", { name: "B Member" });
    fireEvent.mouseDown(option);

    await waitFor(() =>
      expect(loadPage).toHaveBeenCalledWith(
        expect.objectContaining({ politicianSlug: "b-member", offset: 0 }),
      ),
    );
  });

  it("closes the list on Escape and returns focus to the field on clear", async () => {
    searchPoliticiansMock.mockResolvedValue({
      hits: [{ slug: "b-member", display_name: "B Member" }],
    });
    // The action echoes the query it ran, as the real one does: the island
    // reconciles its controls to that echo, so a fixture that echoed a different
    // query would unmount the chip under the test's feet.
    const loadPage = jest
      .fn()
      .mockImplementation(async (query: RegisterActivityQuery) => page({ query }));
    render(<RegisterActivityExplorer initialPage={page()} loadPage={loadPage} />);

    const input = screen.getByLabelText("Member");
    fireEvent.change(input, { target: { value: "Member" } });
    await screen.findByRole("listbox", { name: "Member results" });
    await screen.findByRole("option", { name: "B Member" });

    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(input).toHaveAttribute("aria-expanded", "false");

    // And from a selected state, clearing puts focus back on the search field.
    fireEvent.focus(input);
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    const clear = await screen.findByRole("button", { name: "Clear member" });
    fireEvent.click(clear);
    await waitFor(() => expect(screen.getByLabelText("Member")).toHaveFocus());
  });

  it("says in the list when nothing matched, as a row that cannot be chosen", async () => {
    searchPoliticiansMock.mockResolvedValue({ hits: [] });
    render(<RegisterActivityExplorer initialPage={page()} loadPage={jest.fn()} />);

    fireEvent.change(screen.getByLabelText("Member"), { target: { value: "Zzz" } });

    const listbox = await screen.findByRole("listbox", { name: "Member results" });
    // EXTENDED 2026-08-02. The lookup is now announced while it is in flight,
    // and "no members match" is suppressed until it has actually answered — so
    // this has to WAIT for the answer rather than reading the first frame.
    // That ordering is the point of the change: the typeahead measured 657 ms
    // (~420 ms after the last keystroke) with no busy affordance in 5 of 5
    // runs, and the copy on screen during that wait was an absence claim about
    // named people that had not been established yet.
    expect(within(listbox).getByText(/searching members/i)).toBeInTheDocument();
    expect(within(listbox).queryByText(/no members match/i)).toBeNull();

    expect(
      await within(listbox).findByText(/no members match/i),
    ).toBeInTheDocument();
    expect(within(listbox).queryByText(/searching members/i)).toBeNull();
    expect(within(listbox).queryAllByRole("option")).toHaveLength(0);
  });

  it("says search is down without saying anything about the register", async () => {
    searchPoliticiansMock.mockRejectedValue(new Error("algolia is down"));
    render(<RegisterActivityExplorer initialPage={page()} loadPage={jest.fn()} />);

    fireEvent.change(screen.getByLabelText("Member"), { target: { value: "Member" } });

    // Announced, not merely rendered: a reader who is not looking at this corner
    // of the page otherwise learns nothing changed.
    const notice = await screen.findByText(/the other filters still work/i);
    expect(notice).toHaveAttribute("role", "status");
    expect(notice).toHaveTextContent(/member search is unavailable right now/i);
    // …and the same fact appears IN the list, as a row that cannot be chosen.
    const listbox = screen.getByRole("listbox", { name: "Member results" });
    expect(within(listbox).getByText(/only the lookup is down/i)).toBeInTheDocument();
    expect(within(listbox).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByRole("link", { name: "A Member" })).toBeInTheDocument();
  });
});
