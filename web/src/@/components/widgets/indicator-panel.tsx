"use client";

import { useState, useMemo } from "react";
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
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "~/@/components/ui/accordion";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/@/components/ui/tabs";
import { Input } from "~/@/components/ui/input";
import { Label } from "~/@/components/ui/label";
import { X, Plus, Activity, Settings2, TrendingUp, BarChart3, LineChart } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  type IndicatorConfig,
  type IndicatorType,
  type IndicatorCategory,
  type IndicatorDataSource,
  INDICATOR_PERIODS,
  INDICATOR_METADATA,
  getIndicatorColor,
  getIndicatorsByCategory,
  getIndicatorCategories,
  isIndicatorAvailable,
  isOscillator,
  isMultiOutput,
  getIndicatorLabel,
} from "@/lib/technical-indicators";

interface IndicatorPanelProps {
  indicators: IndicatorConfig[];
  onIndicatorsChange: (indicators: IndicatorConfig[]) => void;
  stockCodes: string[];
  className?: string;
  /** Available data sources */
  availableDataSources?: IndicatorDataSource[];
  /** Whether market data has OHLCV */
  hasOHLCV?: boolean;
  /** Whether market data has volume */
  hasVolume?: boolean;
}

const CATEGORY_ICONS: Record<IndicatorCategory, React.ReactNode> = {
  "Moving Averages": <LineChart className="h-3 w-3" />,
  Momentum: <TrendingUp className="h-3 w-3" />,
  Volatility: <Activity className="h-3 w-3" />,
  Trend: <TrendingUp className="h-3 w-3" />,
  Statistical: <BarChart3 className="h-3 w-3" />,
  Volume: <BarChart3 className="h-3 w-3" />,
};

export function IndicatorPanel({
  indicators,
  onIndicatorsChange,
  stockCodes,
  className,
  availableDataSources = ["shorts", "market"],
  hasOHLCV = false,
  hasVolume = false,
}: IndicatorPanelProps) {
  const [isAddingIndicator, setIsAddingIndicator] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<IndicatorCategory>("Moving Averages");
  const [newIndicator, setNewIndicator] = useState<Partial<IndicatorConfig>>({
    type: "SMA",
    period: 20,
    stockCode: stockCodes[0] ?? "",
    dataSource: availableDataSources[0] ?? "shorts",
    enabled: true,
  });

  // Get available indicators for current data source
  const availableIndicators = useMemo(() => {
    const dataSource = newIndicator.dataSource ?? "shorts";
    const hasVol = dataSource === "market" && hasVolume;
    const hasOhlc = dataSource === "market" && hasOHLCV;

    return getIndicatorsByCategory(selectedCategory).filter((meta) =>
      isIndicatorAvailable(meta.type, dataSource, hasOhlc, hasVol)
    );
  }, [selectedCategory, newIndicator.dataSource, hasOHLCV, hasVolume]);

  // Get metadata for selected indicator type
  const selectedMetadata = useMemo(() => {
    return INDICATOR_METADATA[newIndicator.type as IndicatorType];
  }, [newIndicator.type]);

  const addIndicator = () => {
    if (!newIndicator.type || !newIndicator.period || !newIndicator.stockCode) return;

    const metadata = INDICATOR_METADATA[newIndicator.type as IndicatorType];
    const indicator: IndicatorConfig = {
      type: newIndicator.type as IndicatorType,
      period: newIndicator.period,
      stockCode: newIndicator.stockCode,
      color: getIndicatorColor(indicators.length),
      enabled: true,
      dataSource: newIndicator.dataSource,
      params: newIndicator.params ?? metadata?.defaultParams,
      outputKey: newIndicator.outputKey,
    };

    onIndicatorsChange([...indicators, indicator]);
    setIsAddingIndicator(false);

    // Reset form
    setNewIndicator({
      type: "SMA",
      period: 20,
      stockCode: stockCodes[0] ?? "",
      dataSource: availableDataSources[0] ?? "shorts",
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

  // Update indicator type and reset period to default
  const handleTypeChange = (type: IndicatorType) => {
    const metadata = INDICATOR_METADATA[type];
    setNewIndicator({
      ...newIndicator,
      type,
      period: metadata?.defaultPeriod ?? 20,
      params: metadata?.defaultParams,
      outputKey: undefined,
    });
  };

  return (
    <div className={cn("space-y-2", className)}>
      {/* Active indicators */}
      {indicators.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {indicators.map((indicator, index) => {
            const metadata = INDICATOR_METADATA[indicator.type];
            const isOsc = isOscillator(indicator.type);

            return (
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
                <span className="font-medium">{metadata?.shortName ?? indicator.type}</span>
                <span className="text-muted-foreground ml-1">({indicator.period})</span>
                {stockCodes.length > 1 && (
                  <span className="text-muted-foreground ml-1">• {indicator.stockCode}</span>
                )}
                {indicator.dataSource && availableDataSources.length > 1 && (
                  <span
                    className={cn(
                      "ml-1 text-[10px] px-1 rounded",
                      indicator.dataSource === "shorts"
                        ? "bg-orange-500/20 text-orange-600"
                        : "bg-blue-500/20 text-blue-600"
                    )}
                  >
                    {indicator.dataSource === "shorts" ? "S" : "M"}
                  </span>
                )}
                {isOsc && (
                  <span className="ml-1 text-[10px] px-1 rounded bg-purple-500/20 text-purple-600">
                    OSC
                  </span>
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
            );
          })}
        </div>
      )}

      {/* Add indicator button/form */}
      <Popover open={isAddingIndicator} onOpenChange={setIsAddingIndicator}>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm" className="h-7 text-xs">
            <Plus className="h-3 w-3 mr-1" />
            Add Indicator
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 p-0" align="start">
          <div className="p-3 border-b">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Add Indicator</span>
            </div>
          </div>

          <Tabs defaultValue="browse" className="w-full">
            <TabsList className="w-full grid grid-cols-2 h-9 rounded-none border-b">
              <TabsTrigger value="browse" className="text-xs">Browse</TabsTrigger>
              <TabsTrigger value="configure" className="text-xs">Configure</TabsTrigger>
            </TabsList>

            <TabsContent value="browse" className="m-0 p-3 space-y-3">
              {/* Data source toggle */}
              {availableDataSources.length > 1 && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Apply to</Label>
                  <div className="flex gap-2">
                    {availableDataSources.map((source) => (
                      <Button
                        key={source}
                        variant={newIndicator.dataSource === source ? "default" : "outline"}
                        size="sm"
                        className="h-7 text-xs flex-1"
                        onClick={() =>
                          setNewIndicator({ ...newIndicator, dataSource: source })
                        }
                      >
                        {source === "shorts" ? "📊 Shorts" : "💰 Market"}
                      </Button>
                    ))}
                  </div>
                </div>
              )}

              {/* Categories accordion */}
              <Accordion
                type="single"
                collapsible
                value={selectedCategory}
                onValueChange={(v) => v && setSelectedCategory(v as IndicatorCategory)}
                className="w-full"
              >
                {getIndicatorCategories().map((category) => {
                  const categoryIndicators = getIndicatorsByCategory(category).filter(
                    (meta) =>
                      isIndicatorAvailable(
                        meta.type,
                        newIndicator.dataSource ?? "shorts",
                        hasOHLCV,
                        hasVolume
                      )
                  );

                  if (categoryIndicators.length === 0) return null;

                  return (
                    <AccordionItem key={category} value={category} className="border-b-0">
                      <AccordionTrigger className="py-2 text-xs hover:no-underline">
                        <div className="flex items-center gap-2">
                          {CATEGORY_ICONS[category]}
                          <span>{category}</span>
                          <Badge variant="secondary" className="h-4 text-[10px] px-1">
                            {categoryIndicators.length}
                          </Badge>
                        </div>
                      </AccordionTrigger>
                      <AccordionContent className="pb-2">
                        <div className="grid grid-cols-2 gap-1.5">
                          {categoryIndicators.map((meta) => (
                            <Button
                              key={meta.type}
                              variant={
                                newIndicator.type === meta.type ? "default" : "ghost"
                              }
                              size="sm"
                              className={cn(
                                "h-auto py-1.5 px-2 text-xs justify-start",
                                newIndicator.type === meta.type && "ring-2 ring-primary"
                              )}
                              onClick={() => handleTypeChange(meta.type)}
                            >
                              <div className="flex flex-col items-start">
                                <span className="font-medium">{meta.shortName}</span>
                                {meta.isOscillator && (
                                  <span className="text-[9px] text-purple-500">
                                    Oscillator
                                  </span>
                                )}
                              </div>
                            </Button>
                          ))}
                        </div>
                      </AccordionContent>
                    </AccordionItem>
                  );
                })}
              </Accordion>
            </TabsContent>

            <TabsContent value="configure" className="m-0 p-3 space-y-3">
              {/* Selected indicator info */}
              {selectedMetadata && (
                <div className="p-2 bg-muted rounded-md">
                  <div className="text-xs font-medium">{selectedMetadata.name}</div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">
                    {selectedMetadata.description}
                  </div>
                </div>
              )}

              {/* Period */}
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Period</Label>
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
                  <Label className="text-xs text-muted-foreground">Stock</Label>
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

              {/* MACD-specific params */}
              {newIndicator.type === "MACD" && (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground">MACD Parameters</Label>
                  <div className="grid grid-cols-3 gap-2">
                    <div>
                      <Label className="text-[10px]">Fast</Label>
                      <Input
                        type="number"
                        className="h-7 text-xs"
                        value={newIndicator.params?.fastPeriod ?? 12}
                        onChange={(e) =>
                          setNewIndicator({
                            ...newIndicator,
                            params: {
                              ...newIndicator.params,
                              fastPeriod: parseInt(e.target.value) || 12,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-[10px]">Slow</Label>
                      <Input
                        type="number"
                        className="h-7 text-xs"
                        value={newIndicator.params?.slowPeriod ?? 26}
                        onChange={(e) =>
                          setNewIndicator({
                            ...newIndicator,
                            params: {
                              ...newIndicator.params,
                              slowPeriod: parseInt(e.target.value) || 26,
                            },
                          })
                        }
                      />
                    </div>
                    <div>
                      <Label className="text-[10px]">Signal</Label>
                      <Input
                        type="number"
                        className="h-7 text-xs"
                        value={newIndicator.params?.signalPeriod ?? 9}
                        onChange={(e) =>
                          setNewIndicator({
                            ...newIndicator,
                            params: {
                              ...newIndicator.params,
                              signalPeriod: parseInt(e.target.value) || 9,
                            },
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* Bollinger Bands / Keltner multiplier */}
              {(newIndicator.type === "BBANDS" || newIndicator.type === "KELT") && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Std Dev Multiplier</Label>
                  <Input
                    type="number"
                    step="0.5"
                    className="h-8 text-xs"
                    value={newIndicator.params?.stdDevMultiplier ?? 2}
                    onChange={(e) =>
                      setNewIndicator({
                        ...newIndicator,
                        params: {
                          ...newIndicator.params,
                          stdDevMultiplier: parseFloat(e.target.value) || 2,
                        },
                      })
                    }
                  />
                </div>
              )}

              {/* Stochastic D period */}
              {newIndicator.type === "STOCH" && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">%D Period</Label>
                  <Input
                    type="number"
                    className="h-8 text-xs"
                    value={newIndicator.params?.dPeriod ?? 3}
                    onChange={(e) =>
                      setNewIndicator({
                        ...newIndicator,
                        params: {
                          ...newIndicator.params,
                          dPeriod: parseInt(e.target.value) || 3,
                        },
                      })
                    }
                  />
                </div>
              )}

              {/* Output key selector for multi-output indicators */}
              {selectedMetadata?.hasMultipleOutputs && selectedMetadata.outputKeys && (
                <div className="space-y-1.5">
                  <Label className="text-xs text-muted-foreground">Display Output</Label>
                  <Select
                    value={newIndicator.outputKey ?? "primary"}
                    onValueChange={(value) =>
                      setNewIndicator({
                        ...newIndicator,
                        outputKey: value as IndicatorConfig["outputKey"],
                      })
                    }
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedMetadata.outputKeys.map((key) => (
                        <SelectItem key={key} value={key}>
                          {key.charAt(0).toUpperCase() + key.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </TabsContent>
          </Tabs>

          <div className="p-3 border-t">
            <Button size="sm" className="w-full h-8 text-xs" onClick={addIndicator}>
              Add {selectedMetadata?.shortName ?? newIndicator.type}({newIndicator.period})
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

/**
 * Get oscillator indicators from a list
 */
export function getOscillatorIndicators(
  indicators: IndicatorConfig[]
): IndicatorConfig[] {
  return indicators.filter((ind) => isOscillator(ind.type));
}

/**
 * Get overlay indicators (non-oscillator) from a list
 */
export function getOverlayIndicators(
  indicators: IndicatorConfig[]
): IndicatorConfig[] {
  return indicators.filter((ind) => !isOscillator(ind.type));
}
