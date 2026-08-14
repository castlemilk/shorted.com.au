/**
 * The /politicians/donations island publishes AMOUNTS beside named parties and
 * named payers, so the things this file pins are editorial as much as
 * behavioural:
 *
 *   - THE THREE LEDGER MEASURES ARE THREE CHARTS. A party's own annual return,
 *     the receipts its branches itemised and the donations donors declared
 *     giving it are lodged on three forms by different people and do not
 *     reconcile. Stacking or summing them would publish arithmetic that does not
 *     exist.
 *   - A SUBSCRIPTION IS NOT A DONATION. The source's five receipt types render
 *     wherever receipts aggregate, all five of them, including the zeroes —
 *     they are exhaustive, so a reader can check they sum to the total.
 *   - THE CAPTION'S YEAR IS THE RESPONSE'S. An empty request means "the latest
 *     year held" and the server resolves it, so captioning the request would put
 *     a blank, or last year's label, over this year's figures.
 *   - AN EMPTY PAYER LIST MEANS TWO OPPOSITE THINGS. With a party filter set AND
 *     a response that answered it is an honest answer about the filter; with no
 *     filter, or with a request that never answered, it can only be our own
 *     outage — and "no payer is itemised" would then be a false absence claim
 *     about a named party, published on our downtime.
 *   - THE LISTED RAIL NAMES ITS OWN SCOPE. It covers the party groups it
 *     actually fetched, and counts out loud any it did not.
 *   - A SLOW RESPONSE MUST NOT WIN. Two quick filter changes race, and if the
 *     older lands the page shows figures matching neither control.
 */

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import {
  DonationsExplorer,
  type DonationsPage,
  type DonationsQuery,
  type PartyFundingRow,
  type PayerRow,
} from "../donations-explorer";

function baseQuery(overrides: Partial<DonationsQuery> = {}): DonationsQuery {
  return {
    financialYear: "2024-25",
    partyGroup: "",
    limit: 25,
    offset: 0,
    ...overrides,
  };
}

function party(overrides: Partial<PartyFundingRow> = {}): PartyFundingRow {
  return {
    partyGroup: "Australian Labor Party",
    financialYear: "2024-25",
    partyReturnCount: 9,
    totalReceiptsCents: 16_175_271_700,
    itemisedReceiptsCents: 12_507_842_500,
    declaredDonationsCents: 1_594_911_300,
    distinctPayerCount: 1265,
    distinctDonorCount: 210,
    listedPayerCount: 50,
    thresholdCensored: true,
    postReformScheme: false,
    ...overrides,
  };
}

function payer(overrides: Partial<PayerRow> = {}): PayerRow {
  return {
    id: "example holdings",
    donorName: "Example Holdings Pty Ltd",
    donorNameNorm: "example holdings",
    totalCents: 250_000_00,
    receiptCount: 4,
    split: {
      donation: 150_000_00,
      otherReceipt: 60_000_00,
      subscription: 40_000_00,
      publicFunding: 0,
      unspecified: 0,
    },
    recipients: [
      { partyGroup: "Australian Labor Party", amountCents: 150_000_00 },
      { partyGroup: "Liberal", amountCents: 100_000_00 },
    ],
    stockCode: "",
    companyName: "",
    matchMethod: "",
    ...overrides,
  };
}

function page(overrides: Partial<DonationsPage> = {}): DonationsPage {
  return {
    query: baseQuery(),
    financialYear: "2024-25",
    years: [
      { financialYear: "2024-25", partyGroupCount: 42, listedGroupCount: 4 },
      { financialYear: "2023-24", partyGroupCount: 40, listedGroupCount: 3 },
    ],
    parties: [party(), party({ partyGroup: "Liberal", totalReceiptsCents: 20_544_268_400 })],
    corpus: undefined,
    payers: [payer()],
    payerTotal: 1265,
    payerFinancialYear: "2024-25",
    listedPayers: [
      payer({
        id: "BHP|bhp group",
        donorName: "BHP Group Limited",
        donorNameNorm: "bhp group",
        stockCode: "BHP",
        companyName: "BHP Group Ltd",
        matchMethod: "name_exact",
      }),
    ],
    listedGroups: ["Australian Labor Party", "Liberal"],
    listedOmittedGroupCount: 0,
    listedGroupCountKnown: true,
    listedTotal: 1,
    notes: {
      censoring: "SERVED CENSORING NOTE.",
      reform: "SERVED REFORM NOTE.",
      coverage: "SERVED COVERAGE NOTE.",
      verbatim: "SERVED VERBATIM NOTE.",
      donorScope: "SERVED DONOR SCOPE NOTE.",
      attribution: "© Commonwealth of Australia — AEC Transparency Register",
      licence: "CC-BY-4.0",
    },
    asAt: "2026-08-01T00:00:00.000Z",
    overviewOk: true,
    payersOk: true,
    listedOk: true,
    ...overrides,
  };
}

function noopLoad() {
  return jest.fn(async (query: DonationsQuery) => page({ query }));
}

describe("donations explorer", () => {
  it("renders one chart per measure and never stacks them", () => {
    render(<DonationsExplorer initialPage={page()} loadPage={noopLoad()} />);

    // Three headings, three measures, each naming who declared it. Each appears
    // twice by design: once as the visible heading, once in the `sr-only` table
    // caption that carries the same figures for a screen reader.
    for (const measure of [
      /Total receipts, as the party declared them/,
      /Itemised receipts, declared by the recipient/,
      /Donations, declared by the donor/,
    ]) {
      expect(screen.getAllByText(measure).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/never added together or stacked/i)).toBeInTheDocument();
  });

  it("captions with the year the RESPONSE served, not the year requested", () => {
    // The request asked for nothing; the server resolved the latest year held.
    const served = page({
      query: baseQuery({ financialYear: "" }),
      financialYear: "2024-25",
    });
    render(<DonationsExplorer initialPage={served} loadPage={noopLoad()} />);

    expect(
      screen.getByRole("heading", { name: /Party funding declared for 2024-25/ }),
    ).toBeInTheDocument();
  });

  it("renders every served note rather than words of its own", () => {
    render(<DonationsExplorer initialPage={page()} loadPage={noopLoad()} />);

    // The censoring note travels with every list of figures — the charts, the
    // payer table and the listed rail — because each is read as complete
    // without it. The others belong to one place each.
    expect(screen.getAllByText("SERVED CENSORING NOTE.").length).toBeGreaterThan(0);
    expect(screen.getByText("SERVED REFORM NOTE.")).toBeInTheDocument();
    expect(screen.getByText("SERVED DONOR SCOPE NOTE.")).toBeInTheDocument();
  });

  it("shows all five receipt types for a payer, including the empty ones", () => {
    render(<DonationsExplorer initialPage={page()} loadPage={noopLoad()} />);

    // The zero buckets are the point: the five are exhaustive, so their sum is
    // the total beside them, and a reader can only check that if they are all
    // visible. Two payers render (the table row and the listed rail card).
    expect(screen.getAllByText("Donation received").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Other receipt").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Subscription").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Public funding").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Type not stated").length).toBeGreaterThan(0);
    // And the amounts, in dollars — these are cents on the wire, and the five
    // buckets sum to the payer's total beside them.
    expect(screen.getAllByText("$150,000").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$250,000").length).toBeGreaterThan(0);
    // The zero buckets carry a figure too, rather than being left blank.
    expect(screen.getAllByText("$0").length).toBeGreaterThan(0);
  });

  it("renders a payer's verbatim name and links only a matched company", () => {
    render(<DonationsExplorer initialPage={page()} loadPage={noopLoad()} />);

    // Verbatim as lodged, never tidied.
    expect(screen.getByText("Example Holdings Pty Ltd")).toBeInTheDocument();
    // Unmatched payer: no chip, and certainly no link.
    expect(screen.queryByRole("link", { name: /Example Holdings/ })).not.toBeInTheDocument();
    // Matched payer: a link to the stock page.
    const listedLink = screen.getAllByRole("link", { name: /BHP/ })[0];
    expect(listedLink).toHaveAttribute("href", "/shorts/BHP");
  });

  it("names the party groups the listed rail covers", () => {
    render(
      <DonationsExplorer
        initialPage={page({
          listedGroups: ["Australian Labor Party"],
          listedOmittedGroupCount: 2,
        })}
        loadPage={noopLoad()}
      />,
    );

    expect(
      screen.getByText(/Covering receipts declared by Australian Labor Party/),
    ).toBeInTheDocument();
    // What it did NOT reach is counted out loud rather than silently dropped.
    expect(screen.getByText(/further party groups recorded a listed payer/)).toBeInTheDocument();
  });

  it("words an outage as our own, never as an absence in the returns", () => {
    render(
      <DonationsExplorer
        initialPage={page({ payers: [], payersOk: false })}
        loadPage={noopLoad()}
      />,
    );

    expect(screen.getByText(/this is our end/)).toBeInTheDocument();
    expect(screen.queryByText(/No payer is itemised/)).not.toBeInTheDocument();
  });

  it("treats an unfiltered empty payer list as an outage, by arithmetic", () => {
    // The corpus holds 124k itemised receipts; every year in it has payers. So
    // an unfiltered empty list cannot be an honest answer.
    render(
      <DonationsExplorer
        initialPage={page({ payers: [], payersOk: true, query: baseQuery() })}
        loadPage={noopLoad()}
      />,
    );

    expect(screen.getByText(/this is our end/)).toBeInTheDocument();
  });

  it("says 'nothing matched this filter' only when a filter is actually set", () => {
    render(
      <DonationsExplorer
        initialPage={page({
          payers: [],
          payersOk: true,
          query: baseQuery({ partyGroup: "Socialist Alliance" }),
        })}
        loadPage={noopLoad()}
      />,
    );

    expect(screen.getByText(/No payer is itemised under this party group/)).toBeInTheDocument();
    expect(
      screen.getByText(/not a statement about the party/),
    ).toBeInTheDocument();
  });

  it("re-queries through the action when the year changes", async () => {
    const loadPage = noopLoad();
    render(<DonationsExplorer initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Financial year"), {
      target: { value: "2023-24" },
    });

    await waitFor(() => expect(loadPage).toHaveBeenCalled());
    expect(loadPage.mock.calls[0]?.[0]).toMatchObject({
      financialYear: "2023-24",
      offset: 0,
    });
  });

  it("resets to the first page when a filter changes", async () => {
    const loadPage = noopLoad();
    render(
      <DonationsExplorer
        initialPage={page({ query: baseQuery({ offset: 50 }) })}
        loadPage={loadPage}
      />,
    );

    fireEvent.change(screen.getByLabelText("Party group"), {
      target: { value: "Liberal" },
    });

    await waitFor(() => expect(loadPage).toHaveBeenCalled());
    // Keeping the offset would land a reader on page 3 of a 1-page result.
    expect(loadPage.mock.calls[0]?.[0]).toMatchObject({ partyGroup: "Liberal", offset: 0 });
  });

  it("lets only the newest request write to the page", async () => {
    let resolveFirst: (value: DonationsPage) => void = () => {};
    const first = new Promise<DonationsPage>((resolve) => {
      resolveFirst = resolve;
    });
    const loadPage = jest
      .fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(
        page({
          query: baseQuery({ partyGroup: "Liberal" }),
          parties: [party({ partyGroup: "Liberal" })],
          payers: [payer({ id: "second", donorName: "Second Payer Pty Ltd" })],
        }),
      );

    render(<DonationsExplorer initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Financial year"), {
      target: { value: "2023-24" },
    });
    fireEvent.change(screen.getByLabelText("Party group"), {
      target: { value: "Liberal" },
    });

    await waitFor(() => expect(screen.getByText("Second Payer Pty Ltd")).toBeInTheDocument());

    // The stale first response lands afterwards and must be discarded — the page
    // would otherwise show figures matching neither control.
    resolveFirst(
      page({ payers: [payer({ id: "stale", donorName: "Stale Payer Pty Ltd" })] }),
    );
    await waitFor(() => {
      expect(screen.queryByText("Stale Payer Pty Ltd")).not.toBeInTheDocument();
    });
  });

  it("pages from the response's offset under the controls' filters", async () => {
    const loadPage = noopLoad();
    render(
      <DonationsExplorer
        initialPage={page({ query: baseQuery({ offset: 0, limit: 25 }), payerTotal: 100 })}
        loadPage={loadPage}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => expect(loadPage).toHaveBeenCalled());
    expect(loadPage.mock.calls[0]?.[0]).toMatchObject({ offset: 25 });
  });

  /*
   * The measured bug (2026-08-02): `Next` rendered DISABLED at the default page
   * size, so the payer list — 1,768 payers in FY2024-25 — could not be paged at
   * all without first narrowing it, and the range beside it read "1–25 of 0".
   *
   * The cause is a MISSING total, not a wrong one: `listTopDonors` reads through
   * a KV cache whose stored value is a serialised response, and an entry written
   * without the field deserialises with `total` at its zero value while `donors`
   * is a full, correct page. `Number(payers?.total ?? 0)` then publishes a
   * confident 0. A full page is the fallback signal, and it is also what the
   * reader would infer from twenty-five rows.
   */
  it("still offers Next when the response carried no usable total", async () => {
    const loadPage = noopLoad();
    render(
      <DonationsExplorer
        initialPage={page({
          query: baseQuery({ offset: 0, limit: 2 }),
          payers: [payer(), payer({ id: "second", donorName: "Second Payer Pty Ltd" })],
          payerTotal: 0,
        })}
        loadPage={loadPage}
      />,
    );

    const next = screen.getByRole("button", { name: "Next" });
    expect(next).toBeEnabled();
    // …and the contradiction is not printed either: a range, but no "of 0".
    expect(screen.getByText("1–2")).toBeInTheDocument();

    fireEvent.click(next);
    await waitFor(() => expect(loadPage).toHaveBeenCalled());
    expect(loadPage.mock.calls[0]?.[0]).toMatchObject({ offset: 2 });
  });

  it("stops offering Next on a short page with no usable total", () => {
    render(
      <DonationsExplorer
        initialPage={page({
          query: baseQuery({ offset: 0, limit: 25 }),
          payers: [payer()],
          payerTotal: 0,
        })}
        loadPage={noopLoad()}
      />,
    );

    // One row against a page size of 25 is the last page, whatever the total
    // says or fails to say.
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
  });

  it("offers a usable year control even when the overview did not answer", () => {
    render(
      <DonationsExplorer
        initialPage={page({
          years: [],
          overviewOk: false,
          parties: [],
          // THE WHOLE OUTAGE, not half of one. A dead overview leaves no party
          // rows, so the listed rail has nothing to fan out over and no year to
          // be about — it cannot be healthy while the overview is not, and this
          // fixture used to pin the contradiction it was meant to catch.
          listedOk: false,
          listedPayers: [],
          listedGroups: [],
        })}
        loadPage={noopLoad()}
      />,
    );

    const select = screen.getByLabelText("Financial year");
    expect(within(select).getAllByRole("option")).toHaveLength(1);
    // And the charts say it is our outage rather than drawing zero bars.
    expect(screen.getAllByText(/this is our end/).length).toBeGreaterThan(0);
  });

  it("never claims nothing matched an ASX listing when the rail did not answer", () => {
    // The empty fan-out: an outage produces zero listed rows, and wording that
    // as "no payer matched" publishes an affirmative claim about a year's
    // returns out of our own downtime.
    render(
      <DonationsExplorer
        initialPage={page({ listedOk: false, listedPayers: [], listedGroups: [] })}
        loadPage={noopLoad()}
      />,
    );

    expect(screen.queryByText(/matched an ASX listing under these rules/)).not.toBeInTheDocument();
    expect(screen.getByText(/The listed-company list is unavailable/)).toBeInTheDocument();
  });

  it("says nothing matched only when the rail actually answered", () => {
    render(
      <DonationsExplorer
        initialPage={page({ listedOk: true, listedPayers: [], listedTotal: 0 })}
        loadPage={noopLoad()}
      />,
    );

    expect(screen.getByText(/matched an ASX listing under these rules/)).toBeInTheDocument();
  });

  it("blanks the listed rail when the reader's own request failed", async () => {
    // `status === "error"` describes the LAST request, which the flags on the
    // page still on screen cannot: without it the rail keeps rendering stale
    // rows beside two panels saying the request failed.
    const loadPage = jest.fn().mockRejectedValue(new Error("cold start"));
    render(<DonationsExplorer initialPage={page()} loadPage={loadPage} />);

    fireEvent.change(screen.getByLabelText("Financial year"), {
      target: { value: "2023-24" },
    });

    await waitFor(() =>
      expect(screen.getByText(/The listed-company list is unavailable/)).toBeInTheDocument(),
    );
    expect(screen.queryByText("BHP Group Limited")).not.toBeInTheDocument();
  });

  it("states how many party groups the charts are a slice of", () => {
    render(<DonationsExplorer initialPage={page()} loadPage={noopLoad()} />);

    // Two rows drawn, forty-two groups lodged: three charts with no statement of
    // that read as the whole field.
    expect(screen.getByText(/2 largest of 42 party groups/)).toBeInTheDocument();
  });

  it("says when a chart drew only the groups with a figure for its measure", () => {
    render(
      <DonationsExplorer
        initialPage={page({
          parties: [
            party(),
            party({ partyGroup: "Liberal", declaredDonationsCents: 0 }),
          ],
        })}
        loadPage={noopLoad()}
      />,
    );

    // The donations chart drops the zero row; the other two do not. Filtering
    // silently would read as "this party lodged nothing at all". Twice for that
    // one chart: the visible caption and the sr-only table's, which is the
    // parity the bars kit promises.
    expect(
      screen.getAllByText(/Only party groups with a non-zero figure for this measure/).length,
    ).toBe(2);
  });

  it("counts omitted groups from the year's population, or says it cannot", () => {
    const { unmount } = render(
      <DonationsExplorer
        initialPage={page({ listedGroups: ["Australian Labor Party"], listedOmittedGroupCount: 3 })}
        loadPage={noopLoad()}
      />,
    );
    expect(screen.getByText(/further party groups recorded a listed payer/)).toBeInTheDocument();
    unmount();

    // Without the population there is no honest count, so the limitation is
    // stated rather than a zero that reads as "these are all of them".
    render(
      <DonationsExplorer
        initialPage={page({
          listedGroups: ["Australian Labor Party"],
          listedOmittedGroupCount: 0,
          listedGroupCountKnown: false,
        })}
        loadPage={noopLoad()}
      />,
    );
    expect(
      screen.getByText(/not available here, so groups beyond those named cannot be counted/),
    ).toBeInTheDocument();
  });

  it("renders the censoring note beside the payer table and the listed rail too", () => {
    render(<DonationsExplorer initialPage={page()} loadPage={noopLoad()} />);

    // Once with the charts, once with the payer list, once with the rail: every
    // list of figures on this page carries it, because each of the three is read
    // as complete without it.
    expect(screen.getAllByText("SERVED CENSORING NOTE.")).toHaveLength(3);
  });

  it("names which rule linked a payer to a listing, visibly", () => {
    render(<DonationsExplorer initialPage={page()} loadPage={noopLoad()} />);

    // A title attribute is invisible to a touch reader and to a screen reader
    // alike: an exact-name match and a human-verified alias are our decision and
    // the source's arithmetic respectively, and a reader must be able to tell.
    expect(screen.getAllByText(/matched by exact name/).length).toBeGreaterThan(0);
  });

  it("explains the public-funding bucket where the split is legended", () => {
    render(<DonationsExplorer initialPage={page()} loadPage={noopLoad()} />);

    // It heads payer lists in several years, and unexplained it reads as the
    // largest donation of the year.
    expect(screen.getByText(/it is a receipt, not a donation/)).toBeInTheDocument();
  });
});
