"use client";

import { Bell, TrendingDown, DollarSign, ArrowUpDown } from "lucide-react";
import { PremiumGate } from "~/@/components/premium/premium-gate";

function AlertsPreview() {
  return (
    <div className="space-y-4 p-6">
      {[
        { stock: "BHP", type: "Short Position", trigger: "> 8%", icon: TrendingDown },
        { stock: "CBA", type: "Price Alert", trigger: "< $100.00", icon: DollarSign },
        { stock: "CSL", type: "Position Change", trigger: "+/- 1%", icon: ArrowUpDown },
      ].map((alert) => (
        <div key={alert.stock + alert.type} className="rounded-lg border bg-card p-4 flex items-center gap-4">
          <div className="p-2 rounded-md bg-muted">
            <alert.icon className="h-4 w-4 text-muted-foreground" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium">{alert.stock} — {alert.type}</p>
            <p className="text-xs text-muted-foreground">Trigger: {alert.trigger}</p>
          </div>
          <Bell className="h-4 w-4 text-muted-foreground" />
        </div>
      ))}
    </div>
  );
}

export function AlertsContent() {
  return (
    <div className="container py-8">
      <div className="mb-6">
        <h1 className="text-2xl font-bold tracking-tight">Alerts</h1>
        <p className="text-muted-foreground mt-1">
          Get notified when short positions or prices hit your targets.
        </p>
      </div>
      <PremiumGate feature="Alerts" fallback={<AlertsPreview />}>
        <AlertsPreview />
        <p className="text-center text-sm text-muted-foreground mt-4">
          Coming soon — configure and manage your stock alerts.
        </p>
      </PremiumGate>
    </div>
  );
}
