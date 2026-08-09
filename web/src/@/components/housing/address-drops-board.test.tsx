import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";

import { AddressDropsBoard } from "./address-drops-board";

let searchParams = new URLSearchParams("state=vic");

jest.mock("next/navigation", () => ({
  useSearchParams: () => searchParams,
}));

jest.mock("~/app/actions/client/getHousingClient", () => ({
  listAddressPriceDropsClient: jest.fn().mockResolvedValue({ addresses: [] }),
}));

function board(queryClient: QueryClient) {
  return (
    <QueryClientProvider client={queryClient}>
      <AddressDropsBoard />
    </QueryClientProvider>
  );
}

describe("AddressDropsBoard deep-link state", () => {
  beforeEach(() => {
    searchParams = new URLSearchParams("state=vic");
  });

  it("follows a client-side state query change after the board has mounted", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { rerender } = render(board(queryClient));

    expect(screen.getByRole("button", { name: "VIC" })).toHaveClass(
      "bg-foreground",
    );

    searchParams = new URLSearchParams("state=nsw");
    rerender(board(queryClient));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "NSW" })).toHaveClass(
        "bg-foreground",
      ),
    );
  });
});
