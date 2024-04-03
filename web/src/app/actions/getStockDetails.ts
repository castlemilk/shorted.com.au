import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type StockDetails } from "~/gen/stocks/v1alpha1/stocks_pb";

export const getStockDetails = async (
  productCode: string,
): Promise<PlainMessage<StockDetails>> => {
  const transport = createConnectTransport({
    // All transports accept a custom fetch implementation.
    fetch,
    // With Svelte's custom fetch function, we could alternatively
    // use a relative base URL here.
    baseUrl: "https://shorts-ak2zgjnhlq-km.a.run.app",
  });
  const client = createPromiseClient(ShortedStocksService, transport);

  const response = await client.getStockDetails({ productCode });

  return toPlainMessage(response);
};
