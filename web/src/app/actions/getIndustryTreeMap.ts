import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { type PlainMessage, toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { type IndustryTreeMap } from "~/gen/stocks/v1alpha1/stocks_pb";
import { type ViewMode } from "~/gen/shorts/v1alpha1/shorts_pb";
import { SHORTS_API_URL } from "./config";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { cache } from "react";

// React cache() provides request deduplication during a single render
// This prevents duplicate fetches when the same data is needed by multiple components
export const getIndustryTreeMap = cache(
  async (
    period: string,
    limit: number,
    viewMode: ViewMode,
  ): Promise<PlainMessage<IndustryTreeMap>> => {
    const transport = createConnectTransport({
      baseUrl:
        process.env.NEXT_PUBLIC_SHORTS_SERVICE_ENDPOINT ?? SHORTS_API_URL,
    });
    const client = createPromiseClient(ShortedStocksService, transport);

    const response = await client.getIndustryTreeMap({
      period: formatPeriodForAPI(period),
      limit,
      viewMode,
    });

    return toPlainMessage(response);
  },
);
