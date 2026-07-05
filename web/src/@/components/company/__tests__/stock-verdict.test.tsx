import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StockVerdict } from "../stock-verdict";
import { getStockVerdictClient } from "~/app/actions/client/getStockVerdictClient";

jest.mock("~/app/actions/client/getStockVerdictClient", () => ({
  getStockVerdictClient: jest.fn(),
}));

describe("StockVerdict", () => {
  const originalFlag = process.env.NEXT_PUBLIC_STOCK_VERDICT_ENABLED;

  afterEach(() => {
    jest.clearAllMocks();
    if (originalFlag === undefined) {
      delete process.env.NEXT_PUBLIC_STOCK_VERDICT_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_STOCK_VERDICT_ENABLED = originalFlag;
    }
  });

  it("does not call the verdict RPC when the production feature flag is disabled", () => {
    delete process.env.NEXT_PUBLIC_STOCK_VERDICT_ENABLED;
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const { container } = render(
      <QueryClientProvider client={queryClient}>
        <StockVerdict stockCode="LOT" />
      </QueryClientProvider>,
    );

    expect(container).toBeEmptyDOMElement();
    expect(getStockVerdictClient).not.toHaveBeenCalled();
  });
});
