import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import {
  ShortedStocksService,
  type GetHousingOverviewResponse,
  type GetHousePriceSeriesResponse,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { cache } from "react";
import { SHORTS_API_URL } from "./config";
import { withRetryAndNotFound } from "./withRetry";

/** Latest house-price headline metrics per region (optionally filtered by type). */
export const getHousingOverview = cache(
  withRetryAndNotFound(
    async (regionType: string = ""): Promise<GetHousingOverviewResponse> => { // eslint-disable-line @typescript-eslint/no-inferrable-types
      const transport = createConnectTransport({ fetch, baseUrl: SHORTS_API_URL });
      const client = createClient(ShortedStocksService, transport);
      return client.getHousingOverview({ regionType });
    },
  ),
);

/** A single house-price time series for a region × measure (× dwelling type). */
export const getHousePriceSeries = cache(
  withRetryAndNotFound(
    async (
      regionCode: string,
      measure: string,
      dwellingType: string = "", // eslint-disable-line @typescript-eslint/no-inferrable-types
    ): Promise<GetHousePriceSeriesResponse> => {
      const transport = createConnectTransport({ fetch, baseUrl: SHORTS_API_URL });
      const client = createClient(ShortedStocksService, transport);
      return client.getHousePriceSeries({ regionCode, measure, dwellingType });
    },
  ),
);
