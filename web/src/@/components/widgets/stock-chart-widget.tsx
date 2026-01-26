"use client";

import { type WidgetProps } from "~/@/types/dashboard";
import Chart from "~/@/components/ui/chart";

export function StockChartWidget({ config }: WidgetProps) {
  const stockCode = (config.settings?.stockCode as string) || "CBA";

  if (!stockCode) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground">
        <div className="text-center">
          <p className="text-sm font-medium">Stock Chart</p>
          <p className="text-xs mt-2">Configure a stock code to display</p>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <Chart stockCode={stockCode} />
    </div>
  );
}