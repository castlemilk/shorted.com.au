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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

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
    ok: true,
    railsOk: true,
    ...overrides,
  };
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

    // 4 added + 1 removed, from the weekly buckets.
    const line = screen.getByRole("status");
    expect(line).toHaveTextContent(/5\s*dated register events in the last 90 days/i);
    // The rows a dated timeline cannot hold are STATED, never silently absent.
    expect(line).toHaveTextContent(/1,234\s*currently-declared entries state no start date/i);
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

  it("lets a slower earlier request lose to the newest one", async () => {
    let resolveFirst: (value: RegisterActivityPage) => void = () => {};
    const first = new Promise<RegisterActivityPage>((resolve) => {
      resolveFirst = resolve;
    });
    const loadPage = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(
        page({ events: [event({ id: "second", displayName: "Second Result" })] }),
      );

    render(<RegisterActivityExplorer initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "added" } });
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "removed" } });

    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Second Result" })).toBeInTheDocument(),
    );

    // The stale answer lands late and must be ignored entirely.
    resolveFirst(page({ events: [event({ id: "first", displayName: "Stale Result" })] }));
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "Second Result" })).toBeInTheDocument(),
    );
    expect(screen.queryByText("Stale Result")).toBeNull();
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
    render(
      <RegisterActivityExplorer initialPage={page({ railsOk: false })} loadPage={jest.fn()} />,
    );

    expect(screen.getByText(/weekly counts are unavailable/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "A Member" })).toBeInTheDocument();
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
    expect(screen.getByText(/not narrowed by the filters above/i)).toBeInTheDocument();
  });

  it("shows a company's declarer movement as plain member counts", () => {
    render(<RegisterActivityExplorer initialPage={page()} loadPage={jest.fn()} />);

    expect(screen.getByText(/\+2 members \(3 → 5\)/)).toBeInTheDocument();
  });

  it("filters to a member through the search plumbing", async () => {
    searchPoliticiansMock.mockResolvedValue({
      hits: [{ slug: "b-member", display_name: "B Member" }],
    });
    const loadPage = jest.fn().mockResolvedValue(
      page({ query: baseQuery({ politicianSlug: "b-member" }) }),
    );
    render(<RegisterActivityExplorer initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Member"), { target: { value: "Member" } });

    const option = await screen.findByRole("button", { name: "B Member" });
    fireEvent.click(option);

    await waitFor(() =>
      expect(loadPage).toHaveBeenCalledWith(
        expect.objectContaining({ politicianSlug: "b-member", offset: 0 }),
      ),
    );
  });

  it("says search is down without saying anything about the register", async () => {
    searchPoliticiansMock.mockRejectedValue(new Error("algolia is down"));
    render(<RegisterActivityExplorer initialPage={page()} loadPage={jest.fn()} />);

    fireEvent.change(screen.getByLabelText("Member"), { target: { value: "Member" } });

    expect(
      await screen.findByText(/member search is unavailable right now/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "A Member" })).toBeInTheDocument();
  });
});
