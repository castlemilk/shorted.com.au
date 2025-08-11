"use client";

import { useEffect, useState } from "react";
import { type WidgetProps } from "@/types/dashboard";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getMultipleStockQuotes } from "@/lib/stock-data-service";
import { TrendingUp, TrendingDown, DollarSign, Activity } from "lucide-react";
import { useAsyncErrorHandler } from "@/hooks/use-async-error";

interface PortfolioData {
  totalValue: number;
  totalChange: number;
  totalChangePercent: number;
  topGainer: { symbol: string; changePercent: number };
  topLoser: { symbol: string; changePercent: number };
}

// Default portfolio for demo purposes
// In a real app, this would come from user preferences or database
const DEFAULT_PORTFOLIO = [
  { symbol: "CBA", shares: 100 },
  { symbol: "BHP", shares: 50 },
  { symbol: "CSL", shares: 25 },
  { symbol: "WBC", shares: 80 },
  { symbol: "WOW", shares: 40 },
];

export function PortfolioSummaryWidget({ config }: WidgetProps) {
  const [loading, setLoading] = useState(true);
  const [portfolioData, setPortfolioData] = useState<PortfolioData | null>(null);
  const handleAsyncError = useAsyncErrorHandler();

  // Get portfolio from config or use default
  const portfolio = (config.settings?.portfolio as typeof DEFAULT_PORTFOLIO) ?? DEFAULT_PORTFOLIO;

  useEffect(() => {
    const fetchPortfolioData = async () => {
      setLoading(true);
      
      const result = await handleAsyncError(async () => {
        const symbols = portfolio.map(p => p.symbol);
        const stockQuotes = await getMultipleStockQuotes(symbols);

        let totalValue = 0;
        let totalCost = 0;
        let topGainer = { symbol: "", changePercent: -Infinity };
        let topLoser = { symbol: "", changePercent: Infinity };

        portfolio.forEach(({ symbol, shares }) => {
          const quote = stockQuotes.get(symbol);
          if (quote) {
            const value = quote.price * shares;
            const cost = (quote.previousClose || quote.price) * shares;
            totalValue += value;
            totalCost += cost;

            if (quote.changePercent > topGainer.changePercent) {
              topGainer = { symbol, changePercent: quote.changePercent };
            }
            if (quote.changePercent < topLoser.changePercent) {
              topLoser = { symbol, changePercent: quote.changePercent };
            }
          }
        });

        const totalChange = totalValue - totalCost;
        const totalChangePercent = totalCost > 0 ? (totalChange / totalCost) * 100 : 0;

        return {
          totalValue,
          totalChange,
          totalChangePercent,
          topGainer,
          topLoser,
        };
      });
      
      if (result) {
        setPortfolioData(result);
      }
      
      setLoading(false);
    };

    void fetchPortfolioData();
    
    // Refresh every 5 minutes
    const interval = setInterval(() => void fetchPortfolioData(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [portfolio, handleAsyncError]);

  if (loading) {
    return (
      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Skeleton className="h-16" />
          <Skeleton className="h-16" />
        </div>
      </div>
    );
  }

  if (!portfolioData) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <p className="text-sm">Unable to load portfolio data</p>
      </div>
    );
  }

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  };

  return (
    <div className="p-4 h-full">
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Total Value</p>
              <p className="text-2xl font-bold">{formatCurrency(portfolioData.totalValue)}</p>
            </div>
            <DollarSign className="h-8 w-8 text-muted-foreground" />
          </div>
        </Card>

        <Card className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Daily Change</p>
              <p className={`text-2xl font-bold ${portfolioData.totalChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatCurrency(Math.abs(portfolioData.totalChange))}
              </p>
              <p className={`text-sm ${portfolioData.totalChangePercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatPercent(portfolioData.totalChangePercent)}
              </p>
            </div>
            <Activity className={`h-8 w-8 ${portfolioData.totalChange >= 0 ? 'text-green-600' : 'text-red-600'}`} />
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Card className="p-3">
          <div className="flex items-center space-x-2">
            <TrendingUp className="h-4 w-4 text-green-600" />
            <div className="flex-1">
              <p className="text-xs text-muted-foreground">Top Gainer</p>
              <p className="text-sm font-medium">{portfolioData.topGainer.symbol}</p>
              <p className="text-xs text-green-600">
                {formatPercent(portfolioData.topGainer.changePercent)}
              </p>
            </div>
          </div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center space-x-2">
            <TrendingDown className="h-4 w-4 text-red-600" />
            <div className="flex-1">
              <p className="text-xs text-muted-foreground">Top Loser</p>
              <p className="text-sm font-medium">{portfolioData.topLoser.symbol}</p>
              <p className="text-xs text-red-600">
                {formatPercent(portfolioData.topLoser.changePercent)}
              </p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}