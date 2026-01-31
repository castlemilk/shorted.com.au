"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { type WidgetProps } from "~/@/types/dashboard";
import { Card } from "~/@/components/ui/card";
import { Skeleton } from "~/@/components/ui/skeleton";
import { Button } from "~/@/components/ui/button";
import { Input } from "~/@/components/ui/input";
import { ScrollArea } from "~/@/components/ui/scroll-area";
import { getMultipleStockQuotes } from "@/lib/stock-data-service";
import { TrendingUp, TrendingDown, DollarSign, Activity, Plus, X, Check } from "lucide-react";
import { useAsyncErrorHandler } from "@/hooks/use-async-error";
import Link from "next/link";

interface PortfolioHolding {
  symbol: string;
  shares: number;
}

interface PortfolioData {
  totalValue: number;
  totalChange: number;
  totalChangePercent: number;
  topGainer: { symbol: string; changePercent: number };
  topLoser: { symbol: string; changePercent: number };
  holdings: Array<{
    symbol: string;
    shares: number;
    price: number;
    value: number;
    change: number;
    changePercent: number;
  }>;
}

// Default portfolio - users can customize via widget settings
const DEFAULT_PORTFOLIO: PortfolioHolding[] = [
  { symbol: "CBA", shares: 100 },
  { symbol: "BHP", shares: 50 },
  { symbol: "CSL", shares: 25 },
  { symbol: "WBC", shares: 80 },
  { symbol: "WOW", shares: 40 },
];

export function PortfolioSummaryWidget({ config, onSettingsChange }: WidgetProps) {
  const [loading, setLoading] = useState(true);
  const [portfolioData, setPortfolioData] = useState<PortfolioData | null>(null);
  const [showAddStock, setShowAddStock] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [newShares, setNewShares] = useState("");
  const [editingHolding, setEditingHolding] = useState<string | null>(null);
  const [editShares, setEditShares] = useState("");
  const [showHoldings, setShowHoldings] = useState(false);
  const handleAsyncError = useAsyncErrorHandler();

  // Get portfolio from config or use default
  const portfolio = useMemo(() => {
    const configPortfolio = config.settings?.portfolio as PortfolioHolding[] | undefined;
    return configPortfolio && configPortfolio.length > 0 ? configPortfolio : DEFAULT_PORTFOLIO;
  }, [config.settings?.portfolio]);

  // Update portfolio in settings
  const updatePortfolio = useCallback((newPortfolio: PortfolioHolding[]) => {
    if (onSettingsChange) {
      onSettingsChange({
        ...config.settings,
        portfolio: newPortfolio,
      });
    }
  }, [onSettingsChange, config.settings]);

  // Add a new holding
  const addHolding = useCallback(() => {
    const symbol = newSymbol.toUpperCase().trim();
    const shares = parseInt(newShares, 10);
    
    if (!symbol || isNaN(shares) || shares <= 0) return;
    
    // Check if already exists
    const existing = portfolio.find(h => h.symbol === symbol);
    if (existing) {
      // Update existing holding
      const updated = portfolio.map(h => 
        h.symbol === symbol ? { ...h, shares: h.shares + shares } : h
      );
      updatePortfolio(updated);
    } else {
      // Add new holding
      updatePortfolio([...portfolio, { symbol, shares }]);
    }
    
    setNewSymbol("");
    setNewShares("");
    setShowAddStock(false);
  }, [newSymbol, newShares, portfolio, updatePortfolio]);

  // Remove a holding
  const removeHolding = useCallback((symbol: string) => {
    updatePortfolio(portfolio.filter(h => h.symbol !== symbol));
  }, [portfolio, updatePortfolio]);

  // Update shares for a holding
  const updateHoldingShares = useCallback((symbol: string, shares: number) => {
    if (shares <= 0) {
      removeHolding(symbol);
      return;
    }
    updatePortfolio(portfolio.map(h => 
      h.symbol === symbol ? { ...h, shares } : h
    ));
    setEditingHolding(null);
  }, [portfolio, updatePortfolio, removeHolding]);

  useEffect(() => {
    const fetchPortfolioData = async () => {
      if (portfolio.length === 0) {
        setLoading(false);
        setPortfolioData(null);
        return;
      }

      setLoading(true);
      
      const result = await handleAsyncError(async () => {
        const symbols = portfolio.map(p => p.symbol);
        const stockQuotes = await getMultipleStockQuotes(symbols);

        let totalValue = 0;
        let totalCost = 0;
        let topGainer = { symbol: "", changePercent: -Infinity };
        let topLoser = { symbol: "", changePercent: Infinity };
        const holdings: PortfolioData["holdings"] = [];

        portfolio.forEach(({ symbol, shares }) => {
          const quote = stockQuotes.get(symbol);
          if (quote) {
            const value = quote.price * shares;
            const cost = (quote.previousClose || quote.price) * shares;
            totalValue += value;
            totalCost += cost;

            holdings.push({
              symbol,
              shares,
              price: quote.price,
              value,
              change: quote.change,
              changePercent: quote.changePercent,
            });

            if (quote.changePercent > topGainer.changePercent) {
              topGainer = { symbol, changePercent: quote.changePercent };
            }
            if (quote.changePercent < topLoser.changePercent) {
              topLoser = { symbol, changePercent: quote.changePercent };
            }
          } else {
            // Include holdings without quotes
            holdings.push({
              symbol,
              shares,
              price: 0,
              value: 0,
              change: 0,
              changePercent: 0,
            });
          }
        });

        const totalChange = totalValue - totalCost;
        const totalChangePercent = totalCost > 0 ? (totalChange / totalCost) * 100 : 0;

        return {
          totalValue,
          totalChange,
          totalChangePercent,
          topGainer: topGainer.symbol ? topGainer : { symbol: "-", changePercent: 0 },
          topLoser: topLoser.symbol ? topLoser : { symbol: "-", changePercent: 0 },
          holdings,
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

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatPrice = (value: number) => {
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
  };

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

  // Empty portfolio state
  if (!portfolioData || portfolio.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-muted-foreground p-4">
        <DollarSign className="h-12 w-12 mb-4 opacity-50" />
        <p className="text-sm font-medium mb-2">No holdings in portfolio</p>
        <p className="text-xs mb-4 text-center">Add stocks to track your portfolio value</p>
        
        {showAddStock ? (
          <div className="flex flex-col gap-2 w-full max-w-xs">
            <Input
              placeholder="Stock code (e.g., CBA)"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              className="h-8"
            />
            <Input
              placeholder="Number of shares"
              type="number"
              value={newShares}
              onChange={(e) => setNewShares(e.target.value)}
              className="h-8"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={addHolding} disabled={!newSymbol || !newShares}>
                Add
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setShowAddStock(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" onClick={() => setShowAddStock(true)}>
            <Plus className="h-4 w-4 mr-1" />
            Add Stock
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 h-full flex flex-col">
      {/* Summary Cards */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Card className="p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Total Value</p>
              <p className="text-xl font-bold">{formatCurrency(portfolioData.totalValue)}</p>
            </div>
            <DollarSign className="h-6 w-6 text-muted-foreground" />
          </div>
        </Card>

        <Card className="p-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs text-muted-foreground">Daily Change</p>
              <p className={`text-xl font-bold ${portfolioData.totalChange >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {portfolioData.totalChange >= 0 ? '+' : ''}{formatCurrency(portfolioData.totalChange)}
              </p>
              <p className={`text-xs ${portfolioData.totalChangePercent >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                {formatPercent(portfolioData.totalChangePercent)}
              </p>
            </div>
            <Activity className={`h-6 w-6 ${portfolioData.totalChange >= 0 ? 'text-green-600' : 'text-red-600'}`} />
          </div>
        </Card>
      </div>

      {/* Top Gainer/Loser */}
      <div className="grid grid-cols-2 gap-3 mb-3">
        <Card className="p-2">
          <div className="flex items-center space-x-2">
            <TrendingUp className="h-4 w-4 text-green-600 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Top Gainer</p>
              <div className="flex items-center gap-1">
                <Link href={`/shorts/${portfolioData.topGainer.symbol}`} className="text-sm font-medium hover:underline">
                  {portfolioData.topGainer.symbol}
                </Link>
                <span className="text-xs text-green-600">
                  {formatPercent(portfolioData.topGainer.changePercent)}
                </span>
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-2">
          <div className="flex items-center space-x-2">
            <TrendingDown className="h-4 w-4 text-red-600 flex-shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted-foreground">Top Loser</p>
              <div className="flex items-center gap-1">
                <Link href={`/shorts/${portfolioData.topLoser.symbol}`} className="text-sm font-medium hover:underline">
                  {portfolioData.topLoser.symbol}
                </Link>
                <span className="text-xs text-red-600">
                  {formatPercent(portfolioData.topLoser.changePercent)}
                </span>
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Holdings Section */}
      <div className="flex-1 min-h-0">
        <div className="flex items-center justify-between mb-2">
          <Button 
            variant="ghost" 
            size="sm" 
            className="text-xs h-6 px-2"
            onClick={() => setShowHoldings(!showHoldings)}
          >
            {showHoldings ? "Hide" : "Show"} Holdings ({portfolio.length})
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0"
            onClick={() => setShowAddStock(!showAddStock)}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>

        {/* Add Stock Form */}
        {showAddStock && (
          <div className="flex gap-2 mb-2">
            <Input
              placeholder="Code"
              value={newSymbol}
              onChange={(e) => setNewSymbol(e.target.value)}
              className="h-7 text-xs w-20"
            />
            <Input
              placeholder="Shares"
              type="number"
              value={newShares}
              onChange={(e) => setNewShares(e.target.value)}
              className="h-7 text-xs w-20"
              onKeyDown={(e) => e.key === "Enter" && addHolding()}
            />
            <Button size="sm" className="h-7 text-xs" onClick={addHolding} disabled={!newSymbol || !newShares}>
              Add
            </Button>
          </div>
        )}

        {/* Holdings List */}
        {showHoldings && (
          <ScrollArea className="h-[calc(100%-2rem)]">
            <div className="space-y-1">
              {portfolioData.holdings.map((holding) => (
                <div
                  key={holding.symbol}
                  className="flex items-center justify-between p-2 rounded-md hover:bg-muted/50 text-xs"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <Link href={`/shorts/${holding.symbol}`} className="font-medium hover:underline">
                      {holding.symbol}
                    </Link>
                    {editingHolding === holding.symbol ? (
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          value={editShares}
                          onChange={(e) => setEditShares(e.target.value)}
                          className="h-5 w-16 text-xs"
                          autoFocus
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              updateHoldingShares(holding.symbol, parseInt(editShares, 10));
                            } else if (e.key === "Escape") {
                              setEditingHolding(null);
                            }
                          }}
                        />
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-5 w-5 p-0"
                          onClick={() => updateHoldingShares(holding.symbol, parseInt(editShares, 10))}
                        >
                          <Check className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="text-muted-foreground cursor-pointer hover:text-foreground bg-transparent border-none p-0 font-inherit"
                        onClick={() => {
                          setEditingHolding(holding.symbol);
                          setEditShares(holding.shares.toString());
                        }}
                        aria-label={`Edit shares for ${holding.symbol}`}
                      >
                        {holding.shares} shares
                      </button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-right">
                      <p className="font-medium">{formatPrice(holding.value)}</p>
                      <p className={holding.changePercent >= 0 ? "text-green-600" : "text-red-600"}>
                        {formatPercent(holding.changePercent)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-5 w-5 p-0 opacity-50 hover:opacity-100"
                      onClick={() => removeHolding(holding.symbol)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          </ScrollArea>
        )}
      </div>
    </div>
  );
}