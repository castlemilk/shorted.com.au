/**
 * The hub table names every parliamentarian in the corpus, so the editorial
 * rules bind it harder than any other surface on the page.
 *
 * Three things here are easy to get wrong and invisible afterwards:
 *
 *   - THE REAL-ESTATE COLUMN IS A FLOOR. It counts currently-declared item-3
 *     ENTRIES, and a large minority of those entries list more than one address.
 *     Rendering it as "properties" states a tally the register does not support,
 *     so the column label is asserted here rather than left to review.
 *   - AN EMPTY TABLE MEANS TWO OPPOSITE THINGS. With a filter set it is an
 *     honest answer about the filter; with no filter it can only be our own
 *     outage, and "no members match" would then read as an absence claim about
 *     every member of parliament at once.
 *   - A SLOW RESPONSE MUST NOT WIN. Two quick filter changes race, and if the
 *     older one is allowed to land the table shows rows matching neither
 *     control while the controls claim otherwise.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  PoliticianRegisterTable,
  type PoliticianTablePage,
  type PoliticianTableQuery,
  type PoliticianTableRow,
} from "../politician-register-table";

/**
 * The query the server would have clamped and echoed back.
 *
 * Built here rather than imported from the island: the island exports no
 * default-query constant on purpose, because a server component cannot read a
 * plain value out of a "use client" module without throwing at prerender time.
 */
function baseQuery(overrides: Partial<PoliticianTableQuery> = {}): PoliticianTableQuery {
  return {
    chamber: "",
    stateCode: "",
    partyAb: "",
    itemNo: 0,
    sort: "declared_items",
    limit: 25,
    offset: 0,
    ...overrides,
  };
}

function row(overrides: Partial<PoliticianTableRow> = {}): PoliticianTableRow {
  return {
    slug: "a-member",
    displayName: "A Member",
    partyAb: "ALP",
    chamber: "house",
    division: "Example",
    stateCode: "NSW",
    declaredItems: 18,
    companies: 6,
    realEstateEntries: 3,
    giftsTravel: 2,
    changes90d: 1,
    undatedCount: 0,
    trend: [
      { month: "2026-06", count: 16 },
      { month: "2026-07", count: 18 },
    ],
    photoUrl: "",
    photoLicence: "",
    photoAuthor: "",
    photoSourceUrl: "",
    ...overrides,
  };
}

function page(overrides: Partial<PoliticianTablePage> = {}): PoliticianTablePage {
  return {
    rows: [row()],
    total: 1,
    query: baseQuery(),
    ...overrides,
  };
}

/** A loader that resolves with the query it was handed, echoed back. */
function echoLoader(rows: PoliticianTableRow[] = [row()], total = rows.length) {
  return jest.fn(async (query: PoliticianTableQuery) => ({ rows, total, query }));
}

describe("politician register table", () => {
  it("renders each column as a count of declared entries", () => {
    render(<PoliticianRegisterTable initialPage={page()} loadPage={echoLoader()} />);

    expect(screen.getByRole("link", { name: "A Member" })).toHaveAttribute(
      "href",
      "/politicians/a-member",
    );
    expect(screen.getByText("Example · NSW")).toBeInTheDocument();
    expect(screen.getByText("Labor")).toBeInTheDocument();
    const cells = screen.getAllByRole("cell");
    expect(cells.map((cell) => cell.textContent)).toEqual(
      expect.arrayContaining(["18", "6", "3", "2", "1"]),
    );
  });

  it("labels the real-estate column as entries, never as properties owned", () => {
    const { container } = render(
      <PoliticianRegisterTable initialPage={page()} loadPage={echoLoader()} />,
    );
    expect(
      screen.getByRole("columnheader", { name: /Real-estate entries/i }),
    ).toBeInTheDocument();
    const text = container.textContent ?? "";
    expect(text).toMatch(/floor on what was declared/i);
    expect(text).not.toMatch(/\bowns\b/i);
    expect(text).not.toMatch(/\d\s+properties\b/i);
  });

  it("carries no risk column, no currency and no warning iconography", () => {
    const { container } = render(
      <PoliticianRegisterTable initialPage={page()} loadPage={echoLoader()} />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toMatch(/\brisk\b/i);
    expect(text).not.toMatch(/\bmonitor\b/i);
    expect(text).not.toMatch(/\bscore\b/i);
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/[⚠🚨🔴🚩👀💰💵🪙💲🏆]/u);
  });

  it("sorts by a column through the action and marks the active header", async () => {
    const loadPage = echoLoader();
    render(<PoliticianRegisterTable initialPage={page()} loadPage={loadPage} />);

    fireEvent.click(screen.getByRole("button", { name: "Companies" }));

    await waitFor(() => expect(loadPage).toHaveBeenCalledTimes(1));
    expect(loadPage).toHaveBeenCalledWith(
      expect.objectContaining({ sort: "companies", offset: 0 }),
    );
    await waitFor(() =>
      expect(screen.getByRole("columnheader", { name: "Companies" })).toHaveAttribute(
        "aria-sort",
        "descending",
      ),
    );
    expect(
      screen.getByRole("columnheader", { name: "Declared entries" }),
    ).toHaveAttribute("aria-sort", "none");
  });

  it("filters by chamber, state, party and register category", async () => {
    const loadPage = echoLoader();
    render(
      <PoliticianRegisterTable
        initialPage={page()}
        loadPage={loadPage}
        stateOptions={["NSW", "VIC"]}
        partyOptions={["ALP", "LP"]}
      />,
    );

    fireEvent.change(screen.getByLabelText("Chamber"), { target: { value: "senate" } });
    await waitFor(() =>
      expect(loadPage).toHaveBeenLastCalledWith(
        expect.objectContaining({ chamber: "senate", offset: 0 }),
      ),
    );

    fireEvent.change(screen.getByLabelText("State"), { target: { value: "VIC" } });
    await waitFor(() =>
      expect(loadPage).toHaveBeenLastCalledWith(expect.objectContaining({ stateCode: "VIC" })),
    );

    fireEvent.change(screen.getByLabelText("Party"), { target: { value: "LP" } });
    await waitFor(() =>
      expect(loadPage).toHaveBeenLastCalledWith(expect.objectContaining({ partyAb: "LP" })),
    );

    fireEvent.change(screen.getByLabelText("Register category"), { target: { value: "3" } });
    await waitFor(() =>
      expect(loadPage).toHaveBeenLastCalledWith(expect.objectContaining({ itemNo: 3 })),
    );
  });

  it("resets to the first page when a filter changes", async () => {
    const loadPage = echoLoader();
    render(
      <PoliticianRegisterTable
        initialPage={page({ query: baseQuery({ offset: 50 }), total: 300 })}
        loadPage={loadPage}
      />,
    );

    fireEvent.change(screen.getByLabelText("Chamber"), { target: { value: "house" } });
    await waitFor(() =>
      expect(loadPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 })),
    );
  });

  it("pages forward and back by the server's own limit", async () => {
    const loadPage = echoLoader();
    render(
      <PoliticianRegisterTable initialPage={page({ total: 300 })} loadPage={loadPage} />,
    );

    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() =>
      expect(loadPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 25 })),
    );
  });

  it("ignores a stale response that lands after a newer one", async () => {
    let resolveFirst: ((value: PoliticianTablePage) => void) | undefined;
    const loadPage = jest
      .fn<Promise<PoliticianTablePage>, [PoliticianTableQuery]>()
      .mockImplementationOnce(
        (query) =>
          new Promise<PoliticianTablePage>((resolve) => {
            resolveFirst = () =>
              resolve({ rows: [row({ slug: "stale", displayName: "Stale Member" })], total: 1, query });
          }),
      )
      .mockImplementationOnce(async (query) => ({
        rows: [row({ slug: "fresh", displayName: "Fresh Member" })],
        total: 1,
        query,
      }));

    render(<PoliticianRegisterTable initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Chamber"), { target: { value: "house" } });
    fireEvent.change(screen.getByLabelText("Chamber"), { target: { value: "senate" } });

    await waitFor(() => expect(screen.getByText("Fresh Member")).toBeInTheDocument());
    resolveFirst?.();
    await waitFor(() => expect(screen.getByText("Fresh Member")).toBeInTheDocument());
    expect(screen.queryByText("Stale Member")).toBeNull();
  });

  it("states an empty filtered result as a filter, not as a finding", async () => {
    const loadPage = echoLoader([], 0);
    render(<PoliticianRegisterTable initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Chamber"), { target: { value: "senate" } });

    await waitFor(() =>
      expect(screen.getByText(/No members match these filters/i)).toBeInTheDocument(),
    );
    expect(screen.queryByText(/declared nothing/i)).toBeNull();
  });

  it("states an unfiltered empty table as an outage, never as an absence", () => {
    render(
      <PoliticianRegisterTable
        initialPage={page({ rows: [], total: 0 })}
        loadPage={echoLoader()}
      />,
    );
    expect(screen.getByText(/table is unavailable right now/i)).toBeInTheDocument();
    expect(screen.queryByText(/No members match/i)).toBeNull();
  });

  it("says nothing is missing from the register when the action fails", async () => {
    const loadPage = jest.fn(async () => {
      throw new Error("boom");
    });
    render(<PoliticianRegisterTable initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Chamber"), { target: { value: "senate" } });
    await waitFor(() =>
      expect(
        screen.getByText(/nothing here is missing from the register/i),
      ).toBeInTheDocument(),
    );
  });

  it("gives the table a caption and every count column a header", () => {
    const { container } = render(
      <PoliticianRegisterTable initialPage={page()} loadPage={echoLoader()} />,
    );
    // Not getByRole("table"): each sparkline ships its own screen-reader table
    // of monthly counts, so the row's own caption is what identifies this one.
    const caption = container.querySelector("caption");
    expect(caption?.textContent).toMatch(/Every column is a count of declared entries/i);
    for (const header of [
      "Member",
      "Declared entries",
      "Companies",
      "Real-estate entries",
      "Gifts & travel",
      "Changes (90d)",
      "12-month trend",
    ]) {
      expect(screen.getByRole("columnheader", { name: header })).toBeInTheDocument();
    }
  });

  it("stands in for a missing portrait rather than borrowing one", () => {
    render(<PoliticianRegisterTable initialPage={page()} loadPage={echoLoader()} />);
    expect(
      screen.getByRole("img", { name: /A Member, Labor — no portrait available/ }),
    ).toBeInTheDocument();
  });

  it("says an undated member has no dated history instead of drawing a flat line", () => {
    render(
      <PoliticianRegisterTable
        initialPage={page({ rows: [row({ trend: [], undatedCount: 12 })] })}
        loadPage={echoLoader()}
      />,
    );
    expect(
      screen.getByRole("img", { name: /no dated history is available/i }),
    ).toBeInTheDocument();
  });

  it("labels an unrecorded party rather than guessing one", () => {
    render(
      <PoliticianRegisterTable
        initialPage={page({ rows: [row({ partyAb: "" })] })}
        loadPage={echoLoader()}
      />,
    );
    expect(screen.getByText("Party not recorded")).toBeInTheDocument();
    expect(screen.queryByText("Independent")).toBeNull();
  });
});
