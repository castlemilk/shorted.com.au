import { createConnectTransport } from "@connectrpc/connect-web";
import { createPromiseClient } from "@connectrpc/connect";
import { toPlainMessage } from "@bufbuild/protobuf";
import { ShortedStocksService } from "~/gen/shorts/v1alpha1/shorts_connect";
import { formatPeriodForAPI } from "~/lib/period-utils";
import { SHORTS_API_URL } from "./config";

// Client-side data fetching for use in Client Components
// This function is called from useEffect and should not use React cache()
export async function getTopShortsData(
  period: string,
  limit: number,
  offset: number,
) {
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
}
