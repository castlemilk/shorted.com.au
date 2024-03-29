import React from "react";
import { toPlainMessage } from "@bufbuild/protobuf";
// import { UserNav } from "~/@/components/ui/user-nav";
import { Top10Chart } from "./top10";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";

const getData = async () => {
  const transport = createConnectTransport({
    // All transports accept a custom fetch implementation.
    fetch,
    // With Svelte's custom fetch function, we could alternatively
    // use a relative base URL here.
    baseUrl: "https://shorts-ak2zgjnhlq-km.a.run.app",
  });
  const client = createPromiseClient(ShortedStocksService, transport);

  const response = await client.getTopShorts({ period: "3m", limit: 10 });

  return toPlainMessage(response);
};

const Page = async () => {
  const data = (await getData()).timeSeries;
  return (
    <>
      <Top10Chart data={data} />
    </>
  );
};

export default Page;
