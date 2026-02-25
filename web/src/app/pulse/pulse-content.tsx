"use client";

import { Activity, TrendingUp, BarChart3, Zap } from "lucide-react";
import { PremiumGate } from "~/@/components/premium/premium-gate";

function PulsePreview() {
  return (
    <div className="space-y-6 p-6">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {[
          { label: "Market Sentiment", icon: Activity, value: "Bearish" },
          { label: "Short Volume", icon: TrendingUp, value: "$2.4B" },
          { label: "Active Movers", icon: Zap, value: "47" },
        ].map((item) => (
          <div key={item.label} className="rounded-lg border bg-card p-4">
            <div className="flex items-center gap-2 text-sm text-muted-foreground mb-1">
              <item.icon className="h-4 w-4" />
              {item.label}
            </div>
            <p className="text-2xl font-bold">{item.value}</p>
          </div>
        ))}
      </div>
      <div className="rounded-lg border bg-card p-6 h-64 flex items-center justify-center">
        <BarChart3 className="h-16 w-16 text-muted-foreground/30" />
      </div>
    </div>
  );
}

export function PulseContent() {
  return (
    <div className="container py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Market Pulse</h1>
        <p className="text-muted-foreground mt-1">
          Real-time market sentiment and short selling activity.
        </p>
      </div>
      <PremiumGate feature="Market Pulse" fallback={<PulsePreview />}>
        <PulsePreview />
        <p className="text-center text-sm text-muted-foreground mt-4">
          Coming soon — live market pulse data and analysis.
        </p>
      </PremiumGate>
    </div>
  );
}
