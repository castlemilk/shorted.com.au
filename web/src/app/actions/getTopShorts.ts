import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";

export const getTopShortsData = async (period: string, limit: number) => {
  const transport = createConnectTransport({
    // All transports accept a custom fetch implementation.
    fetch,
    // With Svelte's custom fetch function, we could alternatively
    // use a relative base URL here.
    baseUrl: "https://shorts-ak2zgjnhlq-km.a.run.app",
  });
  const client = createPromiseClient(ShortedStocksService, transport);

  const response = await client.getTopShorts({ period, limit });

  return toPlainMessage(response);
};
