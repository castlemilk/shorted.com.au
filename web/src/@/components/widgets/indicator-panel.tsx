"use client";

import { useState } from "react";
import { Button } from "~/@/components/ui/button";
import { Badge } from "~/@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "~/@/components/ui/popover";
import { X, Plus, Activity, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type IndicatorConfig,
  type IndicatorType,
  INDICATOR_PERIODS,
  getIndicatorColor,
} from "@/lib/technical-indicators";

interface IndicatorPanelProps {
  indicators: IndicatorConfig[];
  onIndicatorsChange: (indicators: IndicatorConfig[]) => void;
  stockCodes: string[];
  className?: string;
}

const INDICATOR_TYPES: { value: IndicatorType; label: string; description: string }[] = [
  { value: "SMA", label: "SMA", description: "Simple Moving Average" },
  { value: "WMA", label: "WMA", description: "Weighted Moving Average" },
  { value: "EMA", label: "EMA", description: "Exponential Moving Average" },
];

export function IndicatorPanel({
  indicators,
  onIndicatorsChange,
  stockCodes,
  className,
}: IndicatorPanelProps) {
  const [isAddingIndicator, setIsAddingIndicator] = useState(false);
  const [newIndicator, setNewIndicator] = useState<Partial<IndicatorConfig>>({
    type: "SMA",
    period: 20,
    stockCode: stockCodes[0] ?? "",
    enabled: true,
  });

  const addIndicator = () => {
    if (!newIndicator.type || !newIndicator.period || !newIndicator.stockCode) return;

    const indicator: IndicatorConfig = {
      type: newIndicator.type as IndicatorType,
      period: newIndicator.period,
      stockCode: newIndicator.stockCode,
      color: getIndicatorColor(indicators.length),
      enabled: true,
    };

    onIndicatorsChange([...indicators, indicator]);
    setIsAddingIndicator(false);
    setNewIndicator({
      type: "SMA",
      period: 20,
      stockCode: stockCodes[0] ?? "",
      enabled: true,
    });
  };

  const removeIndicator = (index: number) => {
    const updated = indicators.filter((_, i) => i !== index);
    onIndicatorsChange(updated);
  };

  const toggleIndicator = (index: number) => {
    const updated = indicators.map((ind, i) =>
      i === index ? { ...ind, enabled: !ind.enabled } : ind
    );
    onIndicatorsChange(updated);
  };

  return (
    <div className={cn("space-y-2", className)}>
      {/* Active indicators */}
      <div className="flex flex-wrap gap-1.5">
        {indicators.map((indicator, index) => (
          <Badge
            key={`${indicator.type}-${indicator.period}-${indicator.stockCode}-${index}`}
            variant={indicator.enabled ? "secondary" : "outline"}
            className={cn(
              "pl-2 pr-1 py-1 text-xs cursor-pointer transition-opacity",
              !indicator.enabled && "opacity-50"
            )}
            style={{
              borderLeft: `3px solid ${indicator.color}`,
            }}
            onClick={() => toggleIndicator(index)}
          >
            <span className="font-medium">{indicator.type}</span>
            <span className="text-muted-foreground ml-1">({indicator.period})</span>
            {stockCodes.length > 1 && (
              <span className="text-muted-foreground ml-1">• {indicator.stockCode}</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-4 w-4 ml-1 hover:bg-destructive/20"
              onClick={(e) => {
                e.stopPropagation();
                removeIndicator(index);
              }}
            >
              <X className="h-3 w-3" />
            </Button>
          </Badge>
        ))}
      </div>

      {/* Add indicator button/form */}
      <Popover open={isAddingIndicator} onOpenChange={setIsAddingIndicator}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs">
            <Plus className="h-3 w-3 mr-1" />
            Add Indicator
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-64 p-3" align="start">
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Add Indicator</span>
            </div>

            {/* Indicator type */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Type</label>
              <Select
                value={newIndicator.type}
                onValueChange={(value) =>
                  setNewIndicator({ ...newIndicator, type: value as IndicatorType })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INDICATOR_TYPES.map((type) => (
                    <SelectItem key={type.value} value={type.value}>
                      <div className="flex flex-col">
                        <span>{type.label}</span>
                        <span className="text-xs text-muted-foreground">
                          {type.description}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Period */}
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Period</label>
              <Select
                value={String(newIndicator.period)}
                onValueChange={(value) =>
                  setNewIndicator({ ...newIndicator, period: parseInt(value) })
                }
              >
                <SelectTrigger className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {INDICATOR_PERIODS.map((period) => (
                    <SelectItem key={period} value={String(period)}>
                      {period} periods
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Stock (only show if multiple stocks) */}
            {stockCodes.length > 1 && (
              <div className="space-y-1.5">
                <label className="text-xs text-muted-foreground">Apply to</label>
                <Select
                  value={newIndicator.stockCode}
                  onValueChange={(value) =>
                    setNewIndicator({ ...newIndicator, stockCode: value })
                  }
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {stockCodes.map((code) => (
                      <SelectItem key={code} value={code}>
                        {code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <Button size="sm" className="w-full h-8 text-xs" onClick={addIndicator}>
              Add {newIndicator.type}({newIndicator.period})
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/**
 * Compact indicator toggle for widget header
 */
interface IndicatorToggleProps {
  hasIndicators: boolean;
  onClick: () => void;
}

export function IndicatorToggle({ hasIndicators, onClick }: IndicatorToggleProps) {
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("h-7 w-7 p-0", hasIndicators && "text-primary")}
      onClick={onClick}
      title="Manage indicators"
    >
      <Settings2 className="h-4 w-4" />
    </Button>
  );
}
