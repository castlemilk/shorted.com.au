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
