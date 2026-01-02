import { useEffect, useState } from "react";
import { getHistoricalData, type HistoricalDataPoint } from "@/lib/stock-data-service";

export interface MarketChartData {
  points: Array<{
    date: Date;
    value: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }>;
  stockCode: string;
}

export const useMarketData = (stockCode: string, period: string) => {
  const [data, setData] = useState<MarketChartData | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const historicalData = await getHistoricalData(stockCode, period);
        
        if (!historicalData || historicalData.length === 0) {
          setData(null);
          return;
        }
        
        // Transform historical data to chart format
        const chartData: MarketChartData = {
          stockCode,
          points: historicalData.map((point: HistoricalDataPoint) => ({
            date: new Date(point.date),
            value: point.close,
            open: point.open,
            high: point.high,
            low: point.low,
            close: point.close,
            volume: point.volume,
          }))
        };
        
        setData(chartData);
      } catch (err) {
        console.error(`Failed to fetch market data for ${stockCode}:`, err);
        setError(err as Error);
        setData(null);
      } finally {
        setLoading(false);
      }
    };

    if (stockCode) {
      fetchData().catch((err) => setError(err as Error));
    }
  }, [stockCode, period]);

  return { data, loading, error };
};