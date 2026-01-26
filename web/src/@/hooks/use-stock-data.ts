"use client";

import { useEffect, useState } from "react";
import { type TimeSeriesData } from "~/gen/stocks/v1alpha1/stocks_pb";
import { fetchStockDataClient } from "~/@/lib/client-api";

export const useStockData = (stockCode: string, period: string) => {
  const [data, setData] = useState<TimeSeriesData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      try {
        const fetchedData = await fetchStockDataClient(stockCode, period);
        setData(fetchedData ?? null);
      } catch (err) {
        setError(err as Error);
      } finally {
        setLoading(false);
      }
    };

    fetchData().catch((err) => setError(err as Error)); // Ensure any unhandled rejections are caught

  }, [stockCode, period]);

  return { data, loading, error };
};