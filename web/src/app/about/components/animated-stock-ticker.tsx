"use client";

import { useEffect, useState } from "react";
import { useSpring, animated } from "react-spring";
import { TrendingDown, TrendingUp } from "lucide-react";
import { cn } from "~/@/lib/utils";
import { getTopStocksForDisplay, type StockDisplayData } from "../actions/get-top-stocks";

export function AnimatedStockTicker() {
  const [stocks, setStocks] = useState<StockDisplayData[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isLoading, setIsLoading] = useState(true);

  // CRITICAL: Hooks must be called unconditionally at the top level
  // Always call useSpring, even if we won't use it
  const slideAnimation = useSpring({
    from: { opacity: 0, transform: "translateX(20px)" },
    to: { opacity: stocks.length > 0 ? 1 : 0, transform: "translateX(0)" },
    reset: stocks.length > 0,
    config: { tension: 50, friction: 20 },
  });

  useEffect(() => {
    // Fetch real stock data
    const fetchStocks = async () => {
      try {
        setIsLoading(true);
        const fetchedStocks = await getTopStocksForDisplay(5);
        if (fetchedStocks.length > 0) {
          setStocks(fetchedStocks);
          setCurrentIndex(0);
        }
      } catch (error) {
        console.error("Error fetching stocks:", error);
      } finally {
        setIsLoading(false);
      }
    };

    void fetchStocks();
  }, []);

  useEffect(() => {
    if (stocks.length === 0) return;

    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % stocks.length);
    }, 3000);

    return () => clearInterval(interval);
  }, [stocks.length]);

  if (isLoading) {
    return (
      <div className="relative w-full max-w-2xl mx-auto">
        <div className="bg-gradient-to-br from-card to-card/50 backdrop-blur-sm rounded-2xl border p-6 shadow-xl animate-pulse">
          <div className="h-8 bg-muted rounded w-1/3 mb-4" />
          <div className="grid grid-cols-3 gap-4">
            <div className="h-12 bg-muted rounded" />
            <div className="h-12 bg-muted rounded" />
            <div className="h-12 bg-muted rounded" />
          </div>
        </div>
      </div>
    );
  }

  if (stocks.length === 0) {
    return null; // Don't show anything if no data
  }

  const currentStock = stocks[currentIndex];
  
  if (!currentStock) {
    return null;
  }

  return (
    <div className="relative w-full max-w-2xl mx-auto">
      <animated.div style={slideAnimation} className="w-full">
        <div className="bg-gradient-to-br from-card to-card/50 backdrop-blur-sm rounded-2xl border p-6 shadow-xl">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-3">
                <span className="text-3xl font-bold text-foreground">
                  {currentStock.code}
                </span>
                <span className="text-sm text-muted-foreground">
                  {currentStock.name}
                </span>
              </div>
            </div>
            {currentStock.change !== undefined && currentStock.change >= 0 ? (
              <TrendingUp className="h-6 w-6 text-green-500" />
            ) : (
              <TrendingDown className="h-6 w-6 text-red-500" />
            )}
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-xs text-muted-foreground mb-1">Short %</div>
              <div className="text-2xl font-bold text-blue-500">
                {currentStock.shortPercentage.toFixed(1)}%
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Price</div>
              <div className="text-2xl font-bold">
                {currentStock.price !== undefined ? `$${currentStock.price.toFixed(2)}` : "N/A"}
              </div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">Change</div>
              {currentStock.change !== undefined ? (
                <div
                  className={cn(
                    "text-2xl font-bold",
                    currentStock.change >= 0 ? "text-green-500" : "text-red-500"
                  )}
                >
                  {currentStock.change >= 0 ? "+" : ""}
                  {currentStock.change.toFixed(1)}%
                </div>
              ) : (
                <div className="text-2xl font-bold text-muted-foreground">N/A</div>
              )}
            </div>
          </div>

          {/* Progress bar for short percentage */}
          <div className="mt-4">
            <div className="h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-1000 ease-out"
                style={{ width: `${Math.min(currentStock.shortPercentage * 5, 100)}%` }}
              />
            </div>
          </div>
        </div>
      </animated.div>

      {/* Stock indicators */}
      <div className="flex justify-center gap-2 mt-4">
        {stocks.map((stock, index) => (
          <button
            key={stock.code}
            onClick={() => setCurrentIndex(index)}
            className={cn(
              "h-2 rounded-full transition-all duration-300",
              index === currentIndex
                ? "w-8 bg-blue-500"
                : "w-2 bg-muted-foreground/30 hover:bg-muted-foreground/50"
            )}
            aria-label={`View ${stock.code}`}
          />
        ))}
      </div>
    </div>
  );
}
