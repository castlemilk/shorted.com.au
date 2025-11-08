import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { SHORTS_API_URL } from "./config";
import { cache } from "react";

// React cache() provides request deduplication during a single render
// This prevents duplicate fetches when the same data is needed by multiple components
export const getTopShortsData = cache(
  async (period: string, limit: number, offset: number) => {
    const transport = createConnectTransport({
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
    });

    const client = createPromiseClient(ShortedStocksService, transport);
    const response = await client.getTopShorts({
      period: formatPeriodForAPI(period),
      limit,
      offset,
    });
    return toPlainMessage(response);
  },
);
