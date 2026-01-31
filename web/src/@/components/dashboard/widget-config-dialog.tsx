"use client";

import React, {
  useState,
  useCallback,
  useEffect,
  useRef,
  useMemo,
} from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "~/@/components/ui/dialog";
import { Button } from "~/@/components/ui/button";
import { Input } from "~/@/components/ui/input";
import { Label } from "~/@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/@/components/ui/select";
import { type WidgetConfig } from "~/@/types/dashboard";
import { widgetRegistry } from "@/lib/widget-registry";
import { Badge } from "~/@/components/ui/badge";
import { Switch } from "~/@/components/ui/switch";
import { Checkbox } from "~/@/components/ui/checkbox";
import { X, Search, Loader2 } from "lucide-react";
import { searchStocksClient } from "~/app/actions/searchStocks";
import debounce from "lodash/debounce";
import { cn } from "~/@/lib/utils";

interface StockSearchFieldProps {
  label: string;
  stocks: string[];
  maxItems: number;
  onStocksChange: (stocks: string[]) => void;
}

interface StockSearchResult {
  productCode: string;
  name: string;
  percentageShorted: number;
  industry?: string;
}

function StockSearchField({
  label,
  stocks,
  maxItems,
  onStocksChange,
}: StockSearchFieldProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<StockSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [showSearch, setShowSearch] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchContainerRef = useRef<HTMLDivElement>(null);

  // Fetch search results
  const fetchSearchResults = useCallback(async (query: string) => {
    if (query.length < 1) {
      setSearchResults([]);
      return;
    }

    setSearchLoading(true);
    try {
      const response = await searchStocksClient(query, 8);
      if (response?.stocks) {
        setSearchResults(
          response.stocks.map((stock) => ({
            productCode: stock.productCode,
            name: stock.name,
            percentageShorted: stock.percentageShorted,
            industry: stock.industry,
          })),
        );
      } else {
        setSearchResults([]);
      }
    } catch (error) {
      console.error("Error searching stocks:", error);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  // Debounced search
  const debouncedSearch = useMemo(
    () =>
      debounce((query: string) => {
        void fetchSearchResults(query);
      }, 300),
    [fetchSearchResults],
  );

  useEffect(() => {
    if (searchQuery) {
      debouncedSearch(searchQuery);
    } else {
      setSearchResults([]);
    }
  }, [searchQuery, debouncedSearch]);

  // Handle clicking outside to close search
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        searchContainerRef.current &&
        !searchContainerRef.current.contains(event.target as Node)
      ) {
        setShowSearch(false);
        setSearchQuery("");
        setSearchResults([]);
        setSelectedIndex(-1);
      }
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const addStock = useCallback(
    (stock: StockSearchResult) => {
      if (!stocks.includes(stock.productCode) && stocks.length < maxItems) {
        onStocksChange([...stocks, stock.productCode]);
      }
      setSearchQuery("");
      setSearchResults([]);
      setShowSearch(false);
      setSelectedIndex(-1);
    },
    [stocks, maxItems, onStocksChange],
  );

  const removeStock = useCallback(
    (stockCode: string) => {
      onStocksChange(stocks.filter((s) => s !== stockCode));
    },
    [stocks, onStocksChange],
  );

  // Handle keyboard navigation in search
  const handleKeyDown = (e: React.KeyboardEvent) => {
    switch (e.key) {
      case "ArrowDown":
        if (searchResults.length === 0) return;
        e.preventDefault();
        setSelectedIndex((prev) =>
          prev < searchResults.length - 1 ? prev + 1 : prev,
        );
        break;
      case "ArrowUp":
        if (searchResults.length === 0) return;
        e.preventDefault();
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : -1));
        break;
      case "Enter":
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < searchResults.length) {
          const result = searchResults[selectedIndex];
          if (result) {
            addStock(result);
          }
        } else if (searchQuery.trim() && stocks.length < maxItems) {
          // Allow direct entry if no search results
          const stockCode = searchQuery.toUpperCase().trim();
          if (stockCode && !stocks.includes(stockCode)) {
            onStocksChange([...stocks, stockCode]);
            setSearchQuery("");
          }
        }
        break;
      case "Escape":
        setShowSearch(false);
        setSearchQuery("");
        setSearchResults([]);
        setSelectedIndex(-1);
        break;
    }
  };

  const getShortIntensity = (percentage: number): string => {
    if (percentage >= 15) return "text-red-600 font-semibold";
    if (percentage >= 10) return "text-orange-500 font-medium";
    if (percentage >= 5) return "text-yellow-600";
    return "text-muted-foreground";
  };

  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-2 mb-2">
        {stocks.map((stock, index) => (
          <Badge key={index} variant="secondary" className="pl-2">
            {stock}
            <Button
              variant="ghost"
              size="icon"
              className="h-4 w-4 ml-1"
              onClick={() => removeStock(stock)}
            >
              <X className="h-3 w-3" />
            </Button>
          </Badge>
        ))}
      </div>
      {stocks.length < maxItems && (
        <div ref={searchContainerRef} className="relative">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
            <Input
              ref={searchInputRef}
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value.toUpperCase());
                setShowSearch(true);
              }}
              onKeyDown={handleKeyDown}
              onFocus={() => setShowSearch(true)}
              placeholder="Search stocks to add..."
              className="pl-8 pr-8"
              autoComplete="off"
            />
            {searchLoading ? (
              <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            ) : searchQuery ? (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery("");
                  setSearchResults([]);
                }}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            ) : null}
          </div>

          {/* Search Results Dropdown */}
          {showSearch && searchResults.length > 0 && (
            <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg overflow-hidden">
              <ul className="max-h-[200px] overflow-auto py-1" role="listbox" aria-label="Stock search results">
                {searchResults.map((stock, index) => {
                  const alreadyAdded = stocks.includes(stock.productCode);
                  return (
                    <li
                      key={stock.productCode}
                      onClick={() => !alreadyAdded && addStock(stock)}
                      onKeyDown={(e) => {
                        if (!alreadyAdded && (e.key === "Enter" || e.key === " ")) {
                          e.preventDefault();
                          addStock(stock);
                        }
                      }}
                      role="option"
                      aria-selected={selectedIndex === index}
                      aria-disabled={alreadyAdded}
                      tabIndex={alreadyAdded ? -1 : 0}
                      className={cn(
                        "px-3 py-2 transition-colors text-sm",
                        alreadyAdded
                          ? "opacity-50 cursor-not-allowed"
                          : "cursor-pointer hover:bg-accent",
                        selectedIndex === index && !alreadyAdded && "bg-accent",
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-xs">
                              {stock.productCode}
                            </span>
                            {stock.industry && (
                              <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">
                                {stock.industry}
                              </span>
                            )}
                            {alreadyAdded && (
                              <span className="text-[10px] px-1 py-0.5 rounded bg-green-500/20 text-green-600">
                                Added
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground truncate">
                            {stock.name}
                          </p>
                        </div>
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[10px] h-5",
                            getShortIntensity(stock.percentageShorted),
                          )}
                        >
                          {stock.percentageShorted.toFixed(1)}%
                        </Badge>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* No results */}
          {showSearch &&
            searchQuery.length >= 2 &&
            searchResults.length === 0 &&
            !searchLoading && (
              <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg p-3">
                <p className="text-xs text-muted-foreground text-center">
                  No stocks found for &quot;{searchQuery}&quot;
                </p>
              </div>
            )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        {stocks.length}/{maxItems} stocks
      </p>
    </div>
  );
}

interface WidgetConfigDialogProps {
  widget: WidgetConfig | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (config: WidgetConfig) => void;
}

export function WidgetConfigDialog({
  widget,
  open,
  onOpenChange,
  onSave,
}: WidgetConfigDialogProps) {
  const [config, setConfig] = useState<WidgetConfig | null>(widget);

  // Update config when widget prop changes
  React.useEffect(() => {
    if (widget) {
      setConfig(widget);
    } else {
      setConfig(null);
    }
  }, [widget]);

  const handleSave = () => {
    if (config) {
      onSave(config);
    }
  };

  if (!config || !widget) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Configure Widget</DialogTitle>
          </DialogHeader>
          <div className="py-4">
            <p className="text-sm text-muted-foreground">No widget selected</p>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const definition = widgetRegistry.getDefinition(config.type);
  const schema = definition?.configSchema as
    | {
        type?: string;
        properties?: Record<string, Record<string, unknown>>;
      }
    | undefined;

  const updateSetting = (key: string, value: unknown) => {
    setConfig({
      ...config,
      settings: {
        ...config.settings,
        [key]: value,
      },
    });
  };

  const renderField = (key: string, fieldSchema: Record<string, unknown>) => {
    const value =
      config.settings?.[key] ??
      (fieldSchema.default as string | number | string[] | boolean);

    if (fieldSchema.type === "boolean") {
      return (
        <div key={key} className="flex items-center justify-between space-x-2">
          <Label htmlFor={key} className="flex-1">
            {(fieldSchema.description as string) ??
              key.replace(/([A-Z])/g, " $1").trim()}
          </Label>
          <Switch
            id={key}
            checked={value as boolean}
            onCheckedChange={(checked) => updateSetting(key, checked)}
          />
        </div>
      );
    }

    if (fieldSchema.enum) {
      return (
        <div key={key} className="space-y-2">
          <Label>{key.replace(/([A-Z])/g, " $1").trim()}</Label>
          <Select
            value={value as string}
            onValueChange={(v) => updateSetting(key, v)}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(fieldSchema.enum as string[]).map((option: string) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      );
    }

    if (fieldSchema.type === "number") {
      return (
        <div key={key} className="space-y-2">
          <Label>{key.replace(/([A-Z])/g, " $1").trim()}</Label>
          <Input
            type="number"
            value={value as number}
            onChange={(e) => updateSetting(key, parseInt(e.target.value))}
            min={fieldSchema.minimum as number}
            max={fieldSchema.maximum as number}
          />
        </div>
      );
    }

    // Skip indicator arrays - managed in-widget
    if (fieldSchema.type === "array" && key === "indicators") {
      return (
        <div key={key} className="space-y-2">
          <Label>Indicators</Label>
          <p className="text-xs text-muted-foreground">
            Indicators are configured using the settings panel in the widget
            header.
          </p>
        </div>
      );
    }

    // Stock arrays with string items
    if (
      fieldSchema.type === "array" &&
      (key === "stocks" || key === "watchlist")
    ) {
      return (
        <StockSearchField
          key={key}
          label={
            (fieldSchema.description as string) ||
            key.replace(/([A-Z])/g, " $1").trim()
          }
          stocks={(value as string[]) || []}
          maxItems={(fieldSchema.maxItems as number) || 10}
          onStocksChange={(newStocks) => updateSetting(key, newStocks)}
        />
      );
    }

    // Data types array (checkboxes for shorts/market)
    if (fieldSchema.type === "array" && key === "dataTypes") {
      const currentTypes = (value as string[]) || ["shorts"];
      const itemsSchema = fieldSchema.items as { enum?: string[] } | undefined;
      const availableOptions = itemsSchema?.enum;

      if (!availableOptions) {
        return null;
      }

      return (
        <div key={key} className="space-y-2">
          <Label>
            {(fieldSchema.description as string) ||
              key.replace(/([A-Z])/g, " $1").trim()}
          </Label>
          <div className="space-y-2">
            {availableOptions.map((option) => (
              <div key={option} className="flex items-center space-x-2">
                <Checkbox
                  id={`${key}-${option}`}
                  checked={currentTypes.includes(option)}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      updateSetting(key, [
                        ...currentTypes.filter((t) => t !== option),
                        option,
                      ]);
                    } else {
                      const newTypes = currentTypes.filter((t) => t !== option);
                      // Ensure at least one type is selected
                      if (newTypes.length > 0) {
                        updateSetting(key, newTypes);
                      } else {
                        // If removing last type, keep the other option
                        const otherOption = availableOptions.find(
                          (o) => o !== option,
                        );
                        if (otherOption) {
                          updateSetting(key, [otherOption]);
                        }
                      }
                    }
                  }}
                />
                <Label
                  htmlFor={`${key}-${option}`}
                  className="text-sm font-normal cursor-pointer"
                >
                  {option === "shorts"
                    ? "Show Shorts Data"
                    : option === "market"
                      ? "Show Market Data"
                      : option}
                </Label>
              </div>
            ))}
          </div>
        </div>
      );
    }

    // Stock shorts visibility (object mapping stock codes to boolean)
    if (fieldSchema.type === "object" && key === "stockShortsVisibility") {
      const stocks = (config.settings?.stocks as string[]) || [];
      const visibility = (value as Record<string, boolean>) || {};
      const dataTypes = (config.settings?.dataTypes as string[]) || ["shorts"];
      const showShortsToggle = dataTypes.includes("shorts");

      if (stocks.length === 0) {
        return (
          <div key={key} className="space-y-2">
            <Label>
              {(fieldSchema.description as string) ||
                key.replace(/([A-Z])/g, " $1").trim()}
            </Label>
            <p className="text-xs text-muted-foreground">
              Add stocks above to configure shorts visibility
            </p>
          </div>
        );
      }

      return (
        <div key={key} className="space-y-2">
          <Label>
            {(fieldSchema.description as string) ||
              key.replace(/([A-Z])/g, " $1").trim()}
          </Label>
          <div className="space-y-2 border rounded-md p-3 bg-muted/30">
            {stocks.map((stockCode) => {
              const isVisible = visibility[stockCode] ?? true;
              return (
                <div
                  key={stockCode}
                  className="flex items-center justify-between gap-3 py-2 px-2 rounded-md hover:bg-background/50 transition-colors"
                >
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <Badge variant="secondary" className="font-medium">
                      {stockCode}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    {showShortsToggle && (
                      <div className="flex items-center gap-2">
                        <Label
                          htmlFor={`shorts-visibility-${stockCode}`}
                          className="text-xs text-muted-foreground cursor-pointer"
                        >
                          Show Shorts
                        </Label>
                        <Switch
                          id={`shorts-visibility-${stockCode}`}
                          checked={isVisible}
                          onCheckedChange={(checked) => {
                            updateSetting(key, {
                              ...visibility,
                              [stockCode]: checked,
                            });
                          }}
                        />
                      </div>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-muted-foreground hover:text-destructive"
                      onClick={() => {
                        const newStocks = stocks.filter((s) => s !== stockCode);
                        const newVisibility = { ...visibility };
                        delete newVisibility[stockCode];
                        updateSetting("stocks", newStocks);
                        updateSetting(key, newVisibility);
                      }}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      );
    }

    return (
      <div key={key} className="space-y-2">
        <Label>{key.replace(/([A-Z])/g, " $1").trim()}</Label>
        <Input
          value={value as string}
          onChange={(e) => updateSetting(key, e.target.value)}
        />
      </div>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Configure {config.title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Widget Title</Label>
            <Input
              value={config.title}
              onChange={(e) => setConfig({ ...config, title: e.target.value })}
            />
          </div>
          {schema?.properties ? (
            Object.entries(schema.properties).map(([key, fieldSchema]) =>
              renderField(key, fieldSchema),
            )
          ) : (
            <div className="text-sm text-muted-foreground">
              No configurable settings available
            </div>
          )}
          <div className="space-y-2">
            <Label>Refresh Interval (seconds)</Label>
            <Input
              type="number"
              value={config.dataSource.refreshInterval ?? 0}
              onChange={(e) =>
                setConfig({
                  ...config,
                  dataSource: {
                    ...config.dataSource,
                    refreshInterval: parseInt(e.target.value) || undefined,
                  },
                })
              }
              placeholder="0 = No auto-refresh"
              min={0}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save Changes</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
