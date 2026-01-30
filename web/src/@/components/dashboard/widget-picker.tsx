"use client";

import { useState, useMemo } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { WidgetType, WidgetCategory } from "@/types/dashboard";
import { widgetRegistry } from "@/lib/widget-registry";
import { Search, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface WidgetPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddWidget: (type: WidgetType) => void;
}

// Widget descriptions and preview info
const widgetInfo: Record<
  WidgetType,
  { description: string; preview: string; tags: string[] }
> = {
  [WidgetType.TOP_SHORTS]: {
    description: "Track the most heavily shorted stocks on the ASX",
    preview: "Shows ranking, short %, and sparkline trends",
    tags: ["shorts", "ranking", "overview"],
  },
  [WidgetType.INDUSTRY_TREEMAP]: {
    description: "Visualize short positions by industry sector",
    preview: "Interactive treemap with sector grouping",
    tags: ["industry", "visualization", "sectors"],
  },
  [WidgetType.STOCK_CHART]: {
    description: "Compare multiple stocks with price and short data",
    preview: "Multi-stock chart with technical indicators",
    tags: ["chart", "comparison", "technical"],
  },
  [WidgetType.PORTFOLIO_SUMMARY]: {
    description: "Track your portfolio with short exposure metrics",
    preview: "Holdings overview with short % impact",
    tags: ["portfolio", "holdings", "personal"],
  },
  [WidgetType.WATCHLIST]: {
    description: "Monitor your favorite stocks with live data",
    preview: "Real-time prices, changes, and short positions",
    tags: ["watchlist", "monitoring", "alerts"],
  },
  [WidgetType.TIME_SERIES_ANALYSIS]: {
    description: "Analyze short position trends over time",
    preview: "Trend analysis with customizable timeframes",
    tags: ["analysis", "trends", "advanced"],
  },
  [WidgetType.CORRELATION_MATRIX]: {
    description: "Find correlations between stock movements",
    preview: "Heatmap showing stock correlations",
    tags: ["correlation", "analysis", "matrix"],
  },
  [WidgetType.SECTOR_PERFORMANCE]: {
    description: "Compare sector performance at a glance",
    preview: "Pie/bar charts of sector returns",
    tags: ["sectors", "performance", "comparison"],
  },
  [WidgetType.MARKET_WATCHLIST]: {
    description: "Track market prices with sparklines",
    preview: "Compact price view with mini charts",
    tags: ["market", "prices", "compact"],
  },
};

export function WidgetPicker({
  open,
  onOpenChange,
  onAddWidget,
}: WidgetPickerProps) {
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<WidgetCategory | null>(
    null
  );

  const categories = Object.values(WidgetCategory);

  const filteredWidgets = useMemo(() => {
    const allDefinitions = widgetRegistry.getAllDefinitions();

    return allDefinitions.filter((def) => {
      // Filter by category
      if (selectedCategory && def.category !== selectedCategory) {
        return false;
      }

      // Filter by search query
      if (searchQuery) {
        const query = searchQuery.toLowerCase();
        const info = widgetInfo[def.type];
        const name = def.type.replace(/_/g, " ").toLowerCase();

        return (
          name.includes(query) ||
          info.description.toLowerCase().includes(query) ||
          info.tags.some((tag) => tag.includes(query))
        );
      }

      return true;
    });
  }, [searchQuery, selectedCategory]);

  // Group widgets by category for display
  const widgetsByCategory = useMemo(() => {
    const grouped = new Map<WidgetCategory, typeof filteredWidgets>();

    for (const def of filteredWidgets) {
      const existing = grouped.get(def.category) ?? [];
      grouped.set(def.category, [...existing, def]);
    }

    return grouped;
  }, [filteredWidgets]);

  const handleAddWidget = (type: WidgetType) => {
    onAddWidget(type);
    onOpenChange(false);
    setSearchQuery("");
    setSelectedCategory(null);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:w-[440px] sm:max-w-[440px]">
        <SheetHeader className="space-y-1">
          <SheetTitle>Add Widget</SheetTitle>
          <SheetDescription>
            Choose a widget to add to your dashboard
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search widgets..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-9"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>

          {/* Category filters */}
          <div className="flex flex-wrap gap-2">
            <Badge
              variant={selectedCategory === null ? "default" : "outline"}
              className="cursor-pointer"
              onClick={() => setSelectedCategory(null)}
            >
              All
            </Badge>
            {categories.map((category) => (
              <Badge
                key={category}
                variant={selectedCategory === category ? "default" : "outline"}
                className="cursor-pointer"
                onClick={() =>
                  setSelectedCategory(
                    selectedCategory === category ? null : category
                  )
                }
              >
                {category}
              </Badge>
            ))}
          </div>

          {/* Widget grid */}
          <ScrollArea className="h-[calc(100vh-280px)]">
            <div className="space-y-6 pr-4">
              {selectedCategory
                ? // Single category view
                  filteredWidgets.length > 0 && (
                    <div className="space-y-3">
                      {filteredWidgets.map((def) => (
                        <WidgetCard
                          key={def.type}
                          definition={def}
                          info={widgetInfo[def.type]}
                          onAdd={() => handleAddWidget(def.type)}
                        />
                      ))}
                    </div>
                  )
                : // Grouped by category
                  Array.from(widgetsByCategory.entries()).map(
                    ([category, widgets]) => (
                      <div key={category} className="space-y-3">
                        <h3 className="text-sm font-semibold text-muted-foreground">
                          {category}
                        </h3>
                        {widgets.map((def) => (
                          <WidgetCard
                            key={def.type}
                            definition={def}
                            info={widgetInfo[def.type]}
                            onAdd={() => handleAddWidget(def.type)}
                          />
                        ))}
                      </div>
                    )
                  )}

              {filteredWidgets.length === 0 && (
                <div className="py-8 text-center text-muted-foreground">
                  <p className="text-sm">No widgets found</p>
                  <p className="text-xs mt-1">Try a different search term</p>
                </div>
              )}
            </div>
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface WidgetCardProps {
  definition: ReturnType<typeof widgetRegistry.getDefinition>;
  info: { description: string; preview: string; tags: string[] };
  onAdd: () => void;
}

function WidgetCard({ definition, info, onAdd }: WidgetCardProps) {
  if (!definition) return null;

  const Icon = definition.icon;
  const name = definition.type
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (l) => l.toUpperCase());

  return (
    <div
      className={cn(
        "group relative rounded-lg border bg-card p-4 transition-all",
        "hover:border-primary/50 hover:shadow-sm"
      )}
    >
      <div className="flex items-start gap-3">
        <div className="rounded-md bg-muted p-2">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2">
            <h4 className="font-medium text-sm">{name}</h4>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-2 opacity-0 group-hover:opacity-100 transition-opacity"
              onClick={onAdd}
            >
              <Plus className="h-4 w-4 mr-1" />
              Add
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-1">{info.description}</p>
          <p className="text-xs text-muted-foreground/70 mt-1 italic">
            {info.preview}
          </p>
          <div className="flex flex-wrap gap-1 mt-2">
            {info.tags.map((tag) => (
              <span
                key={tag}
                className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground"
              >
                {tag}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
