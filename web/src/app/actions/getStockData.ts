import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type TimeSeriesData} from "~/gen/stocks/v1alpha1/stocks_pb";

export const getStockData = async (
  productCode: string,
  interval: string,
  
): Promise<PlainMessage<TimeSeriesData>> => {
  const transport = createConnectTransport({
    // All transports accept a custom fetch implementation.
    fetch,
    // With Svelte's custom fetch function, we could alternatively
    // use a relative base URL here.
    baseUrl: "https://shorts-ak2zgjnhlq-km.a.run.app",
  });
  const client = createPromiseClient(ShortedStocksService, transport);

  const response = await client.getStockData({ productCode });
  console.log(response)
  return toPlainMessage(response);
};
