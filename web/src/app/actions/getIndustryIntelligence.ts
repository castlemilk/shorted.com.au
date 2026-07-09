import { createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-web";
import { cache } from "react";

import {
  type GetIndustryIntelligenceResponse,
  ShortedStocksService,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { SERVER_SHORTS_API_URL, serverFetchWithUserAgent } from "./config";
import { withRetryAndNotFound } from "./withRetry";

type GetIndustryIntelligenceAction = (
  industry: string,
  recordLimit?: number,
) => Promise<GetIndustryIntelligenceResponse>;

const fetchIndustryIntelligence: GetIndustryIntelligenceAction = async (
  industry,
  recordLimit = 50,
) => {
  const transport = createConnectTransport({
    fetch: serverFetchWithUserAgent,
    baseUrl: SERVER_SHORTS_API_URL,
  });
  const client = createClient(ShortedStocksService, transport);
  return await client.getIndustryIntelligence({
    industry,
    recordLimit,
  });
};

export const getIndustryIntelligence = cache(
  withRetryAndNotFound(fetchIndustryIntelligence),
);
