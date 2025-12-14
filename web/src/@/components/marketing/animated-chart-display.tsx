"use client";

import { cn } from "~/@/lib/utils";

interface AnimatedChartDisplayProps {
  className?: string;
}

/**
 * A decorative animated chart display that works without API calls
 * Shows a realistic-looking short position chart animation
 */
export function AnimatedChartDisplay({ className }: AnimatedChartDisplayProps) {
  // Static mock data for the chart - no API needed
  const chartPoints = [
    { x: 0, y: 45 },
    { x: 10, y: 52 },
    { x: 20, y: 48 },
    { x: 30, y: 65 },
    { x: 40, y: 58 },
    { x: 50, y: 72 },
    { x: 60, y: 68 },
    { x: 70, y: 85 },
    { x: 80, y: 78 },
    { x: 90, y: 92 },
    { x: 100, y: 88 },
  ];

  // Generate SVG path from points
  const pathD = chartPoints
    .map((point, i) => {
      const x = (point.x / 100) * 280 + 10;
      const y = 120 - (point.y / 100) * 100;
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  // Generate area fill path
  const areaD = `${pathD} L 290 120 L 10 120 Z`;

  return (
    <div className={cn("relative w-full max-w-md mx-auto", className)}>
      {/* Chart container */}
      <div className="relative bg-card/50 backdrop-blur-sm rounded-2xl border border-border/50 p-6 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-600 flex items-center justify-center text-white font-bold text-sm">
              ASX
            </div>
            <div>
              <div className="font-semibold text-foreground">Short Interest Index</div>
              <div className="text-xs text-muted-foreground">Top 50 Most Shorted</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-bold text-foreground tabular-nums">
              12.8%
            </div>
            <div className="text-xs text-emerald-500 font-medium flex items-center justify-end gap-1">
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 10l7-7m0 0l7 7m-7-7v18" />
              </svg>
              +2.3%
            </div>
          </div>
        </div>

        {/* Chart */}
        <div className="relative h-32 w-full">
          <svg
            viewBox="0 0 300 130"
            className="w-full h-full"
            preserveAspectRatio="none"
          >
            {/* Grid lines */}
            <defs>
              <linearGradient id="chart-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="rgb(59, 130, 246)" stopOpacity="0.3" />
                <stop offset="100%" stopColor="rgb(59, 130, 246)" stopOpacity="0" />
              </linearGradient>
              <linearGradient id="line-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="rgb(59, 130, 246)" />
                <stop offset="100%" stopColor="rgb(147, 51, 234)" />
              </linearGradient>
            </defs>

            {/* Horizontal grid lines */}
            {[0, 1, 2, 3].map((i) => (
              <line
                key={i}
                x1="10"
                y1={20 + i * 33}
                x2="290"
                y2={20 + i * 33}
                stroke="currentColor"
                strokeOpacity="0.1"
                strokeWidth="1"
              />
            ))}

            {/* Area fill */}
            <path
              d={areaD}
              fill="url(#chart-gradient)"
              style={{
                animation: "chart-fade-in-up 1s ease-out forwards",
              }}
            />

            {/* Line */}
            <path
              d={pathD}
              fill="none"
              stroke="url(#line-gradient)"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{
                strokeDasharray: 500,
                strokeDashoffset: 0,
                animation: "chart-draw-line 2s ease-out forwards",
              }}
            />

            {/* Current value dot */}
            <circle
              cx="290"
              cy={120 - (88 / 100) * 100}
              r="5"
              fill="rgb(147, 51, 234)"
            />
            <circle
              cx="290"
              cy={120 - (88 / 100) * 100}
              r="8"
              fill="rgb(147, 51, 234)"
              fillOpacity="0.3"
              style={{
                animation: "chart-ping-slow 2s cubic-bezier(0, 0, 0.2, 1) infinite",
              }}
            />
          </svg>
        </div>

        {/* Time labels */}
        <div className="flex justify-between text-xs text-muted-foreground mt-2 px-1">
          <span>30d ago</span>
          <span>15d ago</span>
          <span>Today</span>
        </div>

        {/* Mock data rows */}
        <div className="mt-4 space-y-2">
          {[
            { code: "LKE", name: "Lake Resources", pct: "18.2%" },
            { code: "ZIP", name: "Zip Co Limited", pct: "15.7%" },
            { code: "BRN", name: "Brainchip Holdings", pct: "14.3%" },
          ].map((stock, i) => (
            <div
              key={stock.code}
              className="flex items-center justify-between py-2 px-3 rounded-lg bg-muted/30"
              style={{ 
                animation: "chart-fade-in-up 0.5s ease-out forwards",
                animationDelay: `${800 + i * 150}ms`,
                opacity: 0,
              }}
            >
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold text-sm text-foreground">
                  {stock.code}
                </span>
                <span className="text-xs text-muted-foreground hidden sm:inline">
                  {stock.name}
                </span>
              </div>
              <span className="font-mono text-sm font-semibold text-blue-500">
                {stock.pct}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Decorative elements */}
      <div className="absolute -top-3 -right-3 w-24 h-24 bg-gradient-to-br from-blue-500/20 to-purple-500/20 rounded-full blur-2xl" />
      <div className="absolute -bottom-3 -left-3 w-20 h-20 bg-gradient-to-tr from-emerald-500/20 to-blue-500/20 rounded-full blur-2xl" />

      {/* Global styles for animations */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes chart-draw-line {
          to {
            stroke-dashoffset: 0;
          }
        }
        
        @keyframes chart-fade-in-up {
          from {
            opacity: 0;
            transform: translateY(10px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
        
        @keyframes chart-ping-slow {
          0% {
            transform: scale(1);
            opacity: 0.3;
          }
          50% {
            transform: scale(1.5);
            opacity: 0;
          }
          100% {
            transform: scale(1);
            opacity: 0.3;
          }
        }
      `}} />
    </div>
  );
}

