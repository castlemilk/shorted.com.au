"use client";

import { useEffect, useState } from "react";
import { type WidgetProps } from "~/@/types/dashboard";
import { Skeleton } from "~/@/components/ui/skeleton";
import { getCorrelationMatrix } from "@/lib/stock-data-service";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";

const cool = scaleLinear<string>({
  domain: [-1, 0, 1],
  range: ["#dc2626", "#ffffff", "#2563eb"],
});

const DEFAULT_STOCKS = ["CBA", "BHP", "CSL", "WBC", "ANZ"];

export function CorrelationMatrixWidget({ config }: WidgetProps) {
  const stocks = (config.settings?.stocks as string[]) || DEFAULT_STOCKS;
  const period = (config.settings?.period as string) || "3m";
  
  const [loading, setLoading] = useState(true);
  const [correlationData, setCorrelationData] = useState<Record<string, Record<string, number>>>({});

  useEffect(() => {
    const fetchCorrelations = async () => {
      if (stocks.length < 2) {
        setLoading(false);
        return;
      }

      setLoading(true);
      try {
        const data = await getCorrelationMatrix(stocks, period);
        setCorrelationData(data);
      } catch (error) {
        console.error("Error fetching correlation data:", error);
      } finally {
        setLoading(false);
      }
    };

    void fetchCorrelations();
  }, [stocks, period]);

  if (loading) {
    return (
      <div className="p-4">
        <Skeleton className="h-full w-full" />
      </div>
    );
  }

  if (stocks.length < 2) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm font-medium">Correlation Matrix</p>
          <p className="text-xs mt-2">Select at least 2 stocks to show correlations</p>
        </div>
      </div>
    );
  }

  // Convert object to array format for visualization
  const heatmapData: { x: string; y: string; value: number }[] = [];
  stocks.forEach((stock1) => {
    stocks.forEach((stock2) => {
      const correlation = correlationData[stock1]?.[stock2] ?? 0;
      heatmapData.push({
        x: stock1,
        y: stock2,
        value: correlation,
      });
    });
  });

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 pb-2">
        <h3 className="text-sm font-semibold">Correlation Matrix</h3>
        <p className="text-xs text-muted-foreground">Period: {period}</p>
        <p className="text-xs text-muted-foreground mt-1">
          Based on daily return correlations ({stocks.length} stocks)
        </p>
      </div>
      
      <div className="flex-1 p-4 pt-0">
        <ParentSize>
          {({ width, height }) => {
            const margin = { top: 20, right: 20, bottom: 40, left: 40 };
            const size = Math.min(width - margin.left - margin.right, height - margin.top - margin.bottom);
            const cellSize = size / stocks.length;
            
            return (
              <svg width={width} height={height}>
                <g transform={`translate(${margin.left},${margin.top})`}>
                  {heatmapData.map((d, i) => {
                    const xIndex = stocks.indexOf(d.x);
                    const yIndex = stocks.indexOf(d.y);
                    
                    return (
                      <g key={`cell-${i}`}>
                        <rect
                          x={xIndex * cellSize}
                          y={yIndex * cellSize}
                          width={cellSize}
                          height={cellSize}
                          fill={cool(d.value)}
                          stroke="white"
                          strokeWidth={2}
                        />
                        <text
                          x={xIndex * cellSize + cellSize / 2}
                          y={yIndex * cellSize + cellSize / 2}
                          dy=".35em"
                          fontSize={Math.min(cellSize / 4, 14)}
                          textAnchor="middle"
                          fill={Math.abs(d.value) > 0.5 ? "white" : "black"}
                          fontWeight="bold"
                        >
                          {d.value.toFixed(2)}
                        </text>
                        {/* Add title for tooltip on hover */}
                        <title>
                          {d.x} vs {d.y}: {d.value.toFixed(3)}
                          {"\n"}Correlation strength: {
                            Math.abs(d.value) > 0.7 ? "Strong" :
                            Math.abs(d.value) > 0.4 ? "Moderate" :
                            Math.abs(d.value) > 0.2 ? "Weak" : "Very weak"
                          }
                        </title>
                      </g>
                    );
                  })}
                  
                  {/* X-axis labels */}
                  {stocks.map((stock, i) => (
                    <text
                      key={`x-label-${i}`}
                      x={i * cellSize + cellSize / 2}
                      y={size + 15}
                      fontSize={12}
                      textAnchor="middle"
                      fill="currentColor"
                    >
                      {stock}
                    </text>
                  ))}
                  
                  {/* Y-axis labels */}
                  {stocks.map((stock, i) => (
                    <text
                      key={`y-label-${i}`}
                      x={-10}
                      y={i * cellSize + cellSize / 2}
                      dy=".35em"
                      fontSize={12}
                      textAnchor="end"
                      fill="currentColor"
                    >
                      {stock}
                    </text>
                  ))}
                </g>
              </svg>
            );
          }}
        </ParentSize>
      </div>
      
      <div className="p-4 pt-0">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <div className="w-4 h-4 bg-red-600 rounded" />
            Strong Negative (-1)
          </span>
          <span className="flex items-center gap-2">
            <div className="w-4 h-4 bg-gray-300 rounded" />
            No Correlation (0)
          </span>
          <span className="flex items-center gap-2">
            <div className="w-4 h-4 bg-blue-600 rounded" />
            Strong Positive (+1)
          </span>
        </div>
      </div>
    </div>
  );
}