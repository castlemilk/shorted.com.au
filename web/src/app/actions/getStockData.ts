import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";

export const getStockData = async (
  productCode: string,
  period: string,
): Promise<PlainMessage<TimeSeriesData>> => {
  const transport = createConnectTransport({
    // All transports accept a custom fetch implementation.
    fetch,
    // With Svelte's custom fetch function, we could alternatively
    // use a relative base URL here.
    baseUrl: process.env.SHORTS_SERVICE_ENDPOINT ?? 'http://localhost:8080'
  });
  const client = createPromiseClient(ShortedStocksService, transport);

  const response = await client.getStockData({ productCode, period });
  return toPlainMessage(response);
};
