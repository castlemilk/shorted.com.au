"use client";

import { useQuery } from "@tanstack/react-query";
import { createConnectTransport } from "@connectrpc/connect-web";
import { createClient } from "@connectrpc/connect";
import { StockService } from "~/gen/shorts/v1alpha1/stock_pb";
import { DirectorTradesSkeleton } from "./director-trades-skeleton";
import {
  DIRECTOR_TRADES_LIMIT,
  DirectorTradesView,
} from "./director-trades-view";

interface DirectorTradesTableProps {
  stockCode: string;
  limit?: number;
}

/**
 * The director trades card read in the browser. The Company page reads the
 * trades on the server and draws DirectorTradesView itself; this is the
 * island it falls back to when that read returns nothing, so it fetches for
 * itself and draws the same view.
 */
export function DirectorTradesTable({
  stockCode,
  limit = DIRECTOR_TRADES_LIMIT,
}: DirectorTradesTableProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["director-trades", stockCode, limit],
    queryFn: async () => {
      const transport = createConnectTransport({
        baseUrl: "",
      });
      const client = createClient(StockService, transport);
      return client.getDirectorTrades({ stockCode, limit });
    },
    staleTime: 5 * 60 * 1000,
  });

  // The same card the Company page holds this island's place with.
  if (isLoading) return <DirectorTradesSkeleton />;

  // A failed read says what an empty one does: there are none to show.
  return (
    <DirectorTradesView
      trades={isError ? [] : (data?.trades ?? [])}
      totalCount={data?.totalCount ?? 0}
    />
  );
}
