import { FC, cache } from "react";

import { revalidateTag, unstable_cache } from "next/cache";
import { getTopShorts } from "~/gen/shorts/v1alpha1/shorts-ShortedStocksService_connectquery";

import { createPromiseClient } from "@connectrpc/connect";

import { createConnectTransport } from "@connectrpc/connect-web";

import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { useQuery } from "@connectrpc/connect-query";

// const getTopShorts = async (period: string, limit: number) => {
//   const shortsClient = createPromiseClient(
//     ShortedStocksService,
//     createConnectTransport({
//       baseUrl: "https://shorts-ak2zgjnhlq-km.a.run.app",
//     }),
//   );
//   return shortsClient.getTopShorts({
//     period: period,
//     limit: limit,
//   });
// };

export const Top10: FC = () => {
  //   const stocks = await getTopShorts("3m", 10);
  const { data } = useQuery(getTopShorts);

  return data ? (
    <div>
      <h1>Top 10</h1>
      <ul>
        {data.timeSeries.map((stock) => (
          <li key={stock.productCode}>{stock.productCode}</li>
        ))}
      </ul>
    </div>
  ) : (
    <div>loading...</div>
  );
};
