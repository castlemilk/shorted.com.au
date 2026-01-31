"use client";

import { useMemo } from "react";
import { cn } from "~/@/lib/utils";

interface SentimentGaugeProps {
  value: number; // 0-100, where 0 = extremely bearish, 100 = bullish
}

export function SentimentGauge({ value }: SentimentGaugeProps) {
  const clampedValue = Math.max(0, Math.min(100, value));

  const { label, color, bgColor } = useMemo(() => {
    if (clampedValue < 20)
      return {
        label: "Extreme Fear",
        color: "text-red-500",
        bgColor: "from-red-500/30 to-red-500/10",
      };
    if (clampedValue < 40)
      return {
        label: "Fear",
        color: "text-orange-500",
        bgColor: "from-orange-500/30 to-orange-500/10",
      };
    if (clampedValue < 60)
      return {
        label: "Neutral",
        color: "text-yellow-500",
        bgColor: "from-yellow-500/20 to-yellow-500/5",
      };
    if (clampedValue < 80)
      return {
        label: "Greed",
        color: "text-green-500",
        bgColor: "from-green-500/20 to-green-500/5",
      };
    return {
      label: "Extreme Greed",
      color: "text-emerald-500",
      bgColor: "from-emerald-500/30 to-emerald-500/10",
    };
  }, [clampedValue]);

  // Calculate needle rotation: -90deg (left) to 90deg (right)
  const needleRotation = ((clampedValue / 100) * 180) - 90;

  return (
    <div
      className={cn(
        "rounded-lg border border-border/60 bg-gradient-to-br p-4 h-full flex flex-col",
        bgColor
      )}
      role="meter"
      aria-label={`Market Sentiment: ${label}`}
      aria-valuenow={clampedValue}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={`${Math.round(clampedValue)} out of 100 - ${label}`}
    >
      <div className="text-xs text-muted-foreground mb-2" id="sentiment-label">Market Sentiment</div>

      {/* Gauge */}
      <div className="flex-1 flex items-center justify-center">
        <div className="relative w-40 h-24">
          {/* Gauge background arc */}
          <svg
            viewBox="0 0 200 120"
            className="w-full h-full"
            style={{ overflow: "visible" }}
            aria-hidden="true"
            focusable="false"
          >
            {/* Background arc */}
            <path
              d="M 20 100 A 80 80 0 0 1 180 100"
              fill="none"
              stroke="currentColor"
              strokeWidth="12"
              strokeLinecap="round"
              className="text-muted/30"
            />

            {/* Colored segments */}
            <defs>
              <linearGradient id="gauge-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stopColor="#ef4444" />
                <stop offset="25%" stopColor="#f97316" />
                <stop offset="50%" stopColor="#eab308" />
                <stop offset="75%" stopColor="#22c55e" />
                <stop offset="100%" stopColor="#10b981" />
              </linearGradient>
            </defs>

            {/* Filled arc based on value */}
            <path
              d="M 20 100 A 80 80 0 0 1 180 100"
              fill="none"
              stroke="url(#gauge-gradient)"
              strokeWidth="12"
              strokeLinecap="round"
              strokeDasharray="251.2"
              strokeDashoffset={251.2 * (1 - clampedValue / 100)}
              className="transition-all duration-1000 ease-out"
            />

            {/* Tick marks */}
            {[0, 25, 50, 75, 100].map((tick) => {
              const angle = ((tick / 100) * 180 - 90) * (Math.PI / 180);
              const innerRadius = 65;
              const outerRadius = 75;
              const x1 = 100 + innerRadius * Math.cos(angle);
              const y1 = 100 + innerRadius * Math.sin(angle);
              const x2 = 100 + outerRadius * Math.cos(angle);
              const y2 = 100 + outerRadius * Math.sin(angle);

              return (
                <line
                  key={tick}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  stroke="currentColor"
                  strokeWidth="2"
                  className="text-muted-foreground/50"
                />
              );
            })}

            {/* Needle */}
            <g
              className="transition-transform duration-1000 ease-out"
              style={{
                transformOrigin: "100px 100px",
                transform: `rotate(${needleRotation}deg)`
              }}
            >
              <line
                x1="100"
                y1="100"
                x2="100"
                y2="35"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                className="text-foreground"
              />
              <circle
                cx="100"
                cy="100"
                r="8"
                fill="currentColor"
                className="text-foreground"
              />
              <circle
                cx="100"
                cy="100"
                r="4"
                fill="currentColor"
                className="text-background"
              />
            </g>
          </svg>

          {/* Value display */}
          <div className="absolute bottom-0 left-1/2 -translate-x-1/2 text-center">
            <div className={cn("text-3xl font-bold tabular-nums", color)}>
              {Math.round(clampedValue)}
            </div>
          </div>
        </div>
      </div>

      {/* Label */}
      <div className="text-center">
        <span className={cn("text-sm font-semibold", color)}>{label}</span>
        <div className="text-xs text-muted-foreground mt-1">
          Based on short interest levels
        </div>
      </div>

      {/* Scale labels */}
      <div className="flex justify-between text-xs text-muted-foreground mt-2 px-2" aria-hidden="true">
        <span>Fear</span>
        <span>Greed</span>
      </div>
    </div>
  );
}
