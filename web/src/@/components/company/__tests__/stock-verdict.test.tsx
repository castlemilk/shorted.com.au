import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StockVerdict } from "../stock-verdict";
import { getStockVerdictClient } from "~/app/actions/client/getStockVerdictClient";

jest.mock("~/app/actions/client/getStockVerdictClient", () => ({
  getStockVerdictClient: jest.fn(),
}));

function renderVerdict() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <StockVerdict stockCode="LOT" />
    </QueryClientProvider>,
  );
}

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

  it("is enabled by default (flag unset) and calls the verdict RPC", () => {
    delete process.env.NEXT_PUBLIC_STOCK_VERDICT_ENABLED;
    (getStockVerdictClient as jest.Mock).mockResolvedValue(null);

    renderVerdict();

    expect(getStockVerdictClient).toHaveBeenCalledWith("LOT");
  });

  it("does not call the verdict RPC when the kill switch is set", () => {
    process.env.NEXT_PUBLIC_STOCK_VERDICT_ENABLED = "0";

    const { container } = renderVerdict();

    expect(container).toBeEmptyDOMElement();
    expect(getStockVerdictClient).not.toHaveBeenCalled();
  });
});
