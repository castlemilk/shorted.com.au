import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { SuburbPriceDropsPanel } from "../suburb-price-drops-panel";

const listSuburbPriceDropsClient = jest.fn();

jest.mock("~/app/actions/client/getHousingClient", () => ({
  listSuburbPriceDropsClient: (...args: unknown[]) =>
    listSuburbPriceDropsClient(...args),
}));
jest.mock("../housing-icon", () => ({ HousingIcon: () => null }));

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <SuburbPriceDropsPanel stateCode="NSW" limit={25} />
    </QueryClientProvider>,
  );
}

describe("SuburbPriceDropsPanel", () => {
  beforeEach(() => {
    listSuburbPriceDropsClient.mockReset();
    listSuburbPriceDropsClient.mockResolvedValue({
      suburbs: [
        {
          regionCode: "SUBURB:NSW-2150-PARRAMATTA",
          salCode: "12345",
          salName: "Parramatta",
          stateCode: "NSW",
          postcode: "2150",
          forSaleCount: 130,
          avgAsking: 900_000,
          avgSold: 0,
          soldCount: 0,
          droppedListingCount: 12,
          droppedShare: 0.092,
          maxDropPct: 0.1,
        },
      ],
    });
  });

  // 'share' is a server-side sort (floored at 20 recently swept listings); the
  // panel must offer it and show the column it ranks by.
  it("offers the share sort and shows each suburb's share cut", async () => {
    renderPanel();
    await screen.findByText("9.2%");
    expect(listSuburbPriceDropsClient).toHaveBeenLastCalledWith(
      "NSW",
      "count",
      25,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share cut" }));
    await waitFor(() =>
      expect(listSuburbPriceDropsClient).toHaveBeenLastCalledWith(
        "NSW",
        "share",
        25,
      ),
    );
    expect(
      await screen.findByText(/at least 20 listings seen in the last 14 days/),
    ).toBeInTheDocument();
  });
});

const ts = (iso: string) => ({ seconds: BigInt(Math.floor(Date.parse(iso) / 1000)), nanos: 0 });

const row = (over: Record<string, unknown>) => ({
  regionCode: "SUBURB:NSW-2150-PARRAMATTA", salCode: "12345", salName: "Parramatta",
  stateCode: "NSW", postcode: "2150", forSaleCount: 0, avgAsking: 0, avgSold: 1_200_000,
  soldCount: 3, droppedListingCount: 0, droppedShare: 0, maxDropPct: 0, ...over,
});

describe("SuburbPriceDropsPanel freshness", () => {
  afterEach(() => jest.useRealTimers());

  // The movers board is the same crawl-derived rolling window /price-drops and
  // the council pages date; it showed 38-day-old figures with no date at all.
  it("dates the table and flags it stale past the 72h rule", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-24T00:00:00Z"), doNotFake: ["setTimeout", "setInterval", "queueMicrotask", "nextTick", "setImmediate"] });
    listSuburbPriceDropsClient.mockResolvedValue({
      suburbs: [row({})],
      asOf: ts("2026-09-23T02:00:00Z"),
      dataThrough: ts("2026-08-17T01:46:00Z"),
    });
    renderPanel();
    expect(await screen.findByTestId("suburb-drops-data-to")).toHaveTextContent("Data to 17 Aug 2026");
    expect(screen.getByTestId("suburb-drops-stale")).toHaveTextContent(/runs to 17 Aug 2026, not to today/);
  });

  it("dates fresh data without a stale notice", async () => {
    jest.useFakeTimers({ now: new Date("2026-09-24T00:00:00Z"), doNotFake: ["setTimeout", "setInterval", "queueMicrotask", "nextTick", "setImmediate"] });
    listSuburbPriceDropsClient.mockResolvedValue({
      suburbs: [row({})],
      asOf: ts("2026-09-23T02:00:00Z"),
      dataThrough: ts("2026-09-23T01:00:00Z"),
    });
    renderPanel();
    expect(await screen.findByTestId("suburb-drops-data-to")).toHaveTextContent("Data to 23 Sep 2026");
    expect(screen.queryByTestId("suburb-drops-stale")).not.toBeInTheDocument();
  });
});

describe("SuburbPriceDropsPanel links", () => {
  // sal_code '' is the proto's "unlinked": a link built from the name alone
  // carried an empty ?sal= and 404'd for Brunswick and St Kilda.
  it("does not link a suburb the crawl could not match to an ABS suburb", async () => {
    listSuburbPriceDropsClient.mockResolvedValue({
      suburbs: [
        row({ regionCode: "SUBURB:VIC-3056-BRUNSWICK", salCode: "", salName: "Brunswick", stateCode: "VIC", postcode: "3056" }),
        row({ regionCode: "SUBURB:NSW-2150-PARRAMATTA" }),
      ],
    });
    renderPanel();
    const unlinked = await screen.findByText("brunswick");
    expect(unlinked.closest("a")).toBeNull();
    const linked = screen.getByText("parramatta").closest("a");
    expect(linked).not.toBeNull();
    expect(linked!.getAttribute("href")).toContain("sal=12345");
    for (const a of screen.getAllByRole("link")) {
      expect(a.getAttribute("href")).not.toMatch(/[?&]sal=(&|$)/);
    }
  });
});
