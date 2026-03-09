"use client";

import { useState, useCallback, useTransition, useMemo, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Filter,
  X,
  ChevronDown,
  ChevronUp,
  Search,
  Download,
  FileJson,
  FileText,
  Printer,
} from "lucide-react";
import { create } from "@bufbuild/protobuf";
import {
  ScreenerSortField,
  SortDirection,
  type ScreenerFilters,
  type ScreenerStock,
  ScreenerFiltersSchema,
  RangeFilterSchema,
} from "~/gen/shorts/v1alpha1/shorts_pb";
import { screenStocks } from "~/app/actions/screenStocks";
import { SCREENER_PRESETS, type ScreenerPreset } from "./presets";
import { cn } from "~/@/lib/utils";
import { Badge } from "~/@/components/ui/badge";
import { Button } from "~/@/components/ui/button";
import { Input } from "~/@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "~/@/components/ui/dropdown-menu";
import { downloadCSV } from "~/@/lib/csv-export";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/@/components/ui/table";
import { Popover, PopoverContent, PopoverTrigger } from "~/@/components/ui/popover";
import { Checkbox } from "~/@/components/ui/checkbox";
import { Switch } from "~/@/components/ui/switch";
import { Label } from "~/@/components/ui/label";
import Image from "next/image";
import { getSectorImagePath } from "~/@/lib/sector-images";
import { getKnownIndustries } from "~/@/lib/sector-images";

const PAGE_SIZE = 50;

// Local filter state (using plain numbers, not proto objects)
interface FilterState {
  shortPctMin?: number;
  shortPctMax?: number;
  shortPctChangeMin?: number;
  shortPctChangeMax?: number;
  marketCapMin?: number;
  marketCapMax?: number;
  priceChange1mMin?: number;
  priceChange1mMax?: number;
  peRatioMin?: number;
  peRatioMax?: number;
  dividendYieldMin?: number;
  dividendYieldMax?: number;
  netDirectorBuyMin?: number;
  netDirectorBuyMax?: number;
  avgSentimentMin?: number;
  avgSentimentMax?: number;
  daysToCoverMin?: number;
  daysToCoverMax?: number;
  industries: string[];
  hasDirectorBuys: boolean;
}

const EMPTY_FILTERS: FilterState = {
  industries: [],
  hasDirectorBuys: false,
};

function filtersToProto(f: FilterState): ScreenerFilters {
  const filters = create(ScreenerFiltersSchema, {
    industries: f.industries,
    hasDirectorBuys: f.hasDirectorBuys,
  });

  if (f.shortPctMin !== undefined || f.shortPctMax !== undefined) {
    filters.shortPct = create(RangeFilterSchema, {
      min: f.shortPctMin ?? 0,
      max: f.shortPctMax ?? 0,
      hasMin: f.shortPctMin !== undefined,
      hasMax: f.shortPctMax !== undefined,
    });
  }
  if (f.shortPctChangeMin !== undefined || f.shortPctChangeMax !== undefined) {
    filters.shortPctChange = create(RangeFilterSchema, {
      min: f.shortPctChangeMin ?? 0,
      max: f.shortPctChangeMax ?? 0,
      hasMin: f.shortPctChangeMin !== undefined,
      hasMax: f.shortPctChangeMax !== undefined,
    });
  }
  if (f.marketCapMin !== undefined || f.marketCapMax !== undefined) {
    filters.marketCap = create(RangeFilterSchema, {
      min: f.marketCapMin ?? 0,
      max: f.marketCapMax ?? 0,
      hasMin: f.marketCapMin !== undefined,
      hasMax: f.marketCapMax !== undefined,
    });
  }
  if (f.priceChange1mMin !== undefined || f.priceChange1mMax !== undefined) {
    filters.priceChange1m = create(RangeFilterSchema, {
      min: f.priceChange1mMin ?? 0,
      max: f.priceChange1mMax ?? 0,
      hasMin: f.priceChange1mMin !== undefined,
      hasMax: f.priceChange1mMax !== undefined,
    });
  }
  if (f.peRatioMin !== undefined || f.peRatioMax !== undefined) {
    filters.peRatio = create(RangeFilterSchema, {
      min: f.peRatioMin ?? 0,
      max: f.peRatioMax ?? 0,
      hasMin: f.peRatioMin !== undefined,
      hasMax: f.peRatioMax !== undefined,
    });
  }
  if (f.dividendYieldMin !== undefined || f.dividendYieldMax !== undefined) {
    filters.dividendYield = create(RangeFilterSchema, {
      min: f.dividendYieldMin ?? 0,
      max: f.dividendYieldMax ?? 0,
      hasMin: f.dividendYieldMin !== undefined,
      hasMax: f.dividendYieldMax !== undefined,
    });
  }
  if (f.netDirectorBuyMin !== undefined || f.netDirectorBuyMax !== undefined) {
    filters.netDirectorBuy = create(RangeFilterSchema, {
      min: f.netDirectorBuyMin ?? 0,
      max: f.netDirectorBuyMax ?? 0,
      hasMin: f.netDirectorBuyMin !== undefined,
      hasMax: f.netDirectorBuyMax !== undefined,
    });
  }
  if (f.avgSentimentMin !== undefined || f.avgSentimentMax !== undefined) {
    filters.avgSentiment = create(RangeFilterSchema, {
      min: f.avgSentimentMin ?? 0,
      max: f.avgSentimentMax ?? 0,
      hasMin: f.avgSentimentMin !== undefined,
      hasMax: f.avgSentimentMax !== undefined,
    });
  }
  if (f.daysToCoverMin !== undefined || f.daysToCoverMax !== undefined) {
    filters.daysToCover = create(RangeFilterSchema, {
      min: f.daysToCoverMin ?? 0,
      max: f.daysToCoverMax ?? 0,
      hasMin: f.daysToCoverMin !== undefined,
      hasMax: f.daysToCoverMax !== undefined,
    });
  }

  return filters;
}

function presetToFilterState(preset: ScreenerPreset): FilterState {
  const f = preset.filters;
  return {
    shortPctMin: f.shortPct?.hasMin ? f.shortPct.min : undefined,
    shortPctMax: f.shortPct?.hasMax ? f.shortPct.max : undefined,
    shortPctChangeMin: f.shortPctChange?.hasMin
      ? f.shortPctChange.min
      : undefined,
    shortPctChangeMax: f.shortPctChange?.hasMax
      ? f.shortPctChange.max
      : undefined,
    marketCapMin: f.marketCap?.hasMin ? f.marketCap.min : undefined,
    marketCapMax: f.marketCap?.hasMax ? f.marketCap.max : undefined,
    priceChange1mMin: f.priceChange1m?.hasMin
      ? f.priceChange1m.min
      : undefined,
    priceChange1mMax: f.priceChange1m?.hasMax
      ? f.priceChange1m.max
      : undefined,
    peRatioMin: f.peRatio?.hasMin ? f.peRatio.min : undefined,
    peRatioMax: f.peRatio?.hasMax ? f.peRatio.max : undefined,
    dividendYieldMin: f.dividendYield?.hasMin
      ? f.dividendYield.min
      : undefined,
    dividendYieldMax: f.dividendYield?.hasMax
      ? f.dividendYield.max
      : undefined,
    netDirectorBuyMin: f.netDirectorBuy?.hasMin
      ? f.netDirectorBuy.min
      : undefined,
    netDirectorBuyMax: f.netDirectorBuy?.hasMax
      ? f.netDirectorBuy.max
      : undefined,
    avgSentimentMin: f.avgSentiment?.hasMin ? f.avgSentiment.min : undefined,
    avgSentimentMax: f.avgSentiment?.hasMax ? f.avgSentiment.max : undefined,
    daysToCoverMin: f.daysToCover?.hasMin ? f.daysToCover.min : undefined,
    daysToCoverMax: f.daysToCover?.hasMax ? f.daysToCover.max : undefined,
    industries: [...f.industries],
    hasDirectorBuys: f.hasDirectorBuys,
  };
}

// Active filter descriptions for badges
function getActiveFilterDescriptions(f: FilterState): string[] {
  const desc: string[] = [];
  if (f.shortPctMin !== undefined) desc.push(`Short > ${f.shortPctMin}%`);
  if (f.shortPctMax !== undefined) desc.push(`Short < ${f.shortPctMax}%`);
  if (f.shortPctChangeMin !== undefined)
    desc.push(`Short chg > ${f.shortPctChangeMin}pp`);
  if (f.shortPctChangeMax !== undefined)
    desc.push(`Short chg < ${f.shortPctChangeMax}pp`);
  if (f.marketCapMin !== undefined)
    desc.push(`MCap > $${formatMarketCap(f.marketCapMin)}`);
  if (f.marketCapMax !== undefined)
    desc.push(`MCap < $${formatMarketCap(f.marketCapMax)}`);
  if (f.priceChange1mMin !== undefined)
    desc.push(`Price chg > ${f.priceChange1mMin}%`);
  if (f.priceChange1mMax !== undefined)
    desc.push(`Price chg < ${f.priceChange1mMax}%`);
  if (f.peRatioMin !== undefined) desc.push(`P/E > ${f.peRatioMin}`);
  if (f.peRatioMax !== undefined) desc.push(`P/E < ${f.peRatioMax}`);
  if (f.dividendYieldMin !== undefined)
    desc.push(`Yield > ${f.dividendYieldMin}%`);
  if (f.dividendYieldMax !== undefined)
    desc.push(`Yield < ${f.dividendYieldMax}%`);
  if (f.netDirectorBuyMin !== undefined)
    desc.push(`Dir buy > $${formatCompact(f.netDirectorBuyMin)}`);
  if (f.netDirectorBuyMax !== undefined)
    desc.push(`Dir buy < $${formatCompact(f.netDirectorBuyMax)}`);
  if (f.avgSentimentMin !== undefined)
    desc.push(`Sentiment > ${f.avgSentimentMin}`);
  if (f.avgSentimentMax !== undefined)
    desc.push(`Sentiment < ${f.avgSentimentMax}`);
  if (f.daysToCoverMin !== undefined)
    desc.push(`DTC > ${f.daysToCoverMin}`);
  if (f.daysToCoverMax !== undefined)
    desc.push(`DTC < ${f.daysToCoverMax}`);
  if (f.industries.length > 0)
    desc.push(
      `Industry: ${f.industries.length > 2 ? `${f.industries.length} selected` : f.industries.join(", ")}`,
    );
  if (f.hasDirectorBuys) desc.push("Has director buys");
  return desc;
}

function formatMarketCap(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(0)}M`;
  return formatCompact(value);
}

function formatCompact(value: number): string {
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toFixed(0)}K`;
  return value.toFixed(0);
}

function formatPercent(value: number, decimals = 2): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(decimals)}%`;
}

function formatDollars(value: number): string {
  if (value === 0) return "$0";
  const prefix = value < 0 ? "-$" : "$";
  return `${prefix}${formatCompact(Math.abs(value))}`;
}

const SCREENER_CSV_HEADERS: Record<string, string> = {
  stockCode: "Stock Code",
  companyName: "Company Name",
  shortPct: "Short %",
  daysToCover: "Days to Cover",
  shortPctChange4w: "4W Change",
  priceChange1m: "1M Price Change",
  marketCap: "Market Cap",
  peRatio: "P/E",
  dividendYield: "Yield",
  netDirectorBuyValue: "Director Buys",
  avgSentiment: "Sentiment",
  industry: "Industry",
};

function screenerRowsToPlain(stocks: ScreenerStock[]): Record<string, unknown>[] {
  return stocks.map((s) => ({
    stockCode: s.stockCode,
    companyName: s.companyName,
    shortPct: s.shortPct.toFixed(2),
    daysToCover: s.daysToCover > 0 ? s.daysToCover.toFixed(1) : "",
    shortPctChange4w: s.shortPctChange4w.toFixed(2),
    priceChange1m: s.priceChange1m.toFixed(2),
    marketCap: s.marketCap > 0 ? s.marketCap : "",
    peRatio: s.peRatio > 0 ? s.peRatio.toFixed(1) : "",
    dividendYield: s.dividendYield > 0 ? s.dividendYield.toFixed(2) : "",
    netDirectorBuyValue: s.netDirectorBuyValue !== 0 ? s.netDirectorBuyValue : "",
    avgSentiment: s.newsCount30d > 0 ? s.avgSentiment.toFixed(2) : "",
    industry: s.industry || "",
  }));
}

function downloadBlob(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.setAttribute("href", url);
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function downloadJSON(stocks: ScreenerStock[], filename: string) {
  const rows = screenerRowsToPlain(stocks);
  downloadBlob(JSON.stringify(rows, null, 2), filename, "application/json");
}

function downloadYAML(stocks: ScreenerStock[], filename: string) {
  const rows = screenerRowsToPlain(stocks);
  const lines: string[] = [];
  for (const row of rows) {
    lines.push(`- stockCode: "${String(row.stockCode)}"`);
    for (const [key, val] of Object.entries(row)) {
      if (key === "stockCode") continue;
      const strVal = val === "" || val === null || val === undefined ? '""' : typeof val === "string" && val.includes(",") ? `"${val}"` : String(val);
      lines.push(`  ${key}: ${strVal}`);
    }
  }
  downloadBlob(lines.join("\n"), filename, "text/yaml");
}

// RangeFilterInput component
function RangeFilterInput({
  label,
  minValue,
  maxValue,
  onMinChange,
  onMaxChange,
  placeholder,
  step,
}: {
  label: string;
  minValue?: number;
  maxValue?: number;
  onMinChange: (v?: number) => void;
  onMaxChange: (v?: number) => void;
  placeholder?: { min: string; max: string };
  step?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs font-medium text-muted-foreground">
        {label}
      </Label>
      <div className="flex items-center gap-2">
        <Input
          type="number"
          placeholder={placeholder?.min ?? "Min"}
          value={minValue ?? ""}
          onChange={(e) =>
            onMinChange(e.target.value ? Number(e.target.value) : undefined)
          }
          className="h-8 text-xs"
          step={step}
        />
        <span className="text-xs text-muted-foreground">to</span>
        <Input
          type="number"
          placeholder={placeholder?.max ?? "Max"}
          value={maxValue ?? ""}
          onChange={(e) =>
            onMaxChange(e.target.value ? Number(e.target.value) : undefined)
          }
          className="h-8 text-xs"
          step={step}
        />
      </div>
    </div>
  );
}

export function ScreenerPageClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const initialLoadRef = useRef(false);

  // Data state
  const [results, setResults] = useState<ScreenerStock[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [hasSearched, setHasSearched] = useState(false);

  // Filter state
  const [filters, setFilters] = useState<FilterState>({ ...EMPTY_FILTERS });
  const [activePreset, setActivePreset] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(true);

  // Sort state
  const [sortField, setSortField] = useState<ScreenerSortField>(
    ScreenerSortField.SHORT_PCT,
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(
    SortDirection.DESC,
  );

  // Pagination state
  const [page, setPage] = useState(0);

  const activeFilterDescriptions = useMemo(
    () => getActiveFilterDescriptions(filters),
    [filters],
  );

  const doSearch = useCallback(
    (
      f: FilterState,
      sf: ScreenerSortField,
      sd: SortDirection,
      p: number,
    ) => {
      startTransition(async () => {
        try {
          const protoFilters = filtersToProto(f);
          const response = await screenStocks(
            protoFilters,
            sf,
            sd,
            PAGE_SIZE,
            p * PAGE_SIZE,
          );
          if (response) {
            setResults(response.stocks);
            setTotalCount(response.totalCount);
          } else {
            setResults([]);
            setTotalCount(0);
          }
          setHasSearched(true);
        } catch (error) {
          console.error("Failed to screen stocks:", error);
          setResults([]);
          setTotalCount(0);
          setHasSearched(true);
        }
      });
    },
    [],
  );

  // Auto-load preset from URL query param on initial mount
  useEffect(() => {
    if (initialLoadRef.current) return;
    const presetId = searchParams.get("preset");
    if (presetId) {
      const preset = SCREENER_PRESETS.find((p) => p.id === presetId);
      if (preset) {
        initialLoadRef.current = true;
        const newFilters = presetToFilterState(preset);
        setFilters(newFilters);
        setActivePreset(preset.id);
        setSortField(preset.sortField);
        setSortDirection(preset.sortDirection);
        setPage(0);
        doSearch(newFilters, preset.sortField, preset.sortDirection, 0);
      }
    }
  }, [searchParams, doSearch]);

  const handleSearch = useCallback(() => {
    setPage(0);
    doSearch(filters, sortField, sortDirection, 0);
  }, [filters, sortField, sortDirection, doSearch]);

  const handlePreset = useCallback(
    (preset: ScreenerPreset) => {
      const newFilters = presetToFilterState(preset);
      setFilters(newFilters);
      setActivePreset(preset.id);
      setSortField(preset.sortField);
      setSortDirection(preset.sortDirection);
      setPage(0);
      doSearch(newFilters, preset.sortField, preset.sortDirection, 0);
    },
    [doSearch],
  );

  const handleSort = useCallback(
    (field: ScreenerSortField) => {
      const newDir =
        field === sortField && sortDirection === SortDirection.DESC
          ? SortDirection.ASC
          : SortDirection.DESC;
      setSortField(field);
      setSortDirection(newDir);
      setPage(0);
      doSearch(filters, field, newDir, 0);
    },
    [sortField, sortDirection, filters, doSearch],
  );

  const handlePageChange = useCallback(
    (newPage: number) => {
      setPage(newPage);
      doSearch(filters, sortField, sortDirection, newPage);
    },
    [filters, sortField, sortDirection, doSearch],
  );

  const handleClearFilters = useCallback(() => {
    setFilters({ ...EMPTY_FILTERS });
    setActivePreset(null);
  }, []);

  const updateFilter = useCallback(
    <K extends keyof FilterState>(key: K, value: FilterState[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value }));
      setActivePreset(null);
    },
    [],
  );

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // Sort icon helper
  const SortIcon = ({ field }: { field: ScreenerSortField }) => {
    if (field !== sortField)
      return <ArrowUpDown className="ml-1 h-3 w-3 opacity-40" />;
    return sortDirection === SortDirection.DESC ? (
      <ArrowDown className="ml-1 h-3 w-3" />
    ) : (
      <ArrowUp className="ml-1 h-3 w-3" />
    );
  };

  return (
    <div className="container mx-auto px-4 py-6 max-w-7xl">
      <div className="space-y-5">
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Stock Screener</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Filter ASX stocks by short positions, fundamentals, director trades,
            and news sentiment
          </p>
        </div>

        {/* Presets */}
        <div className="flex flex-wrap gap-2">
          {SCREENER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => handlePreset(preset)}
              className={cn(
                "px-3 py-1.5 rounded-full text-xs font-medium transition-colors border",
                activePreset === preset.id
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-muted/50 text-muted-foreground border-border hover:bg-muted hover:text-foreground",
              )}
              title={preset.description}
            >
              {preset.name}
            </button>
          ))}
        </div>

        {/* Filter panel toggle + active filters */}
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowFilters(!showFilters)}
            className="gap-1.5"
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {showFilters ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
          </Button>

          {activeFilterDescriptions.map((desc) => (
            <Badge key={desc} variant="secondary" className="text-xs gap-1">
              {desc}
              <button
                onClick={() => {
                  // Simple clear: reset all and let user rebuild
                  handleClearFilters();
                }}
                className="hover:text-destructive"
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}

          {activeFilterDescriptions.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearFilters}
              className="text-xs text-muted-foreground"
            >
              Clear all
            </Button>
          )}
        </div>

        {/* Filter panel */}
        {showFilters && (
          <div className="border rounded-lg p-4 bg-muted/20 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <RangeFilterInput
                label="Short Position (%)"
                minValue={filters.shortPctMin}
                maxValue={filters.shortPctMax}
                onMinChange={(v) => updateFilter("shortPctMin", v)}
                onMaxChange={(v) => updateFilter("shortPctMax", v)}
                step={0.5}
              />
              <RangeFilterInput
                label="Short Change 4W (pp)"
                minValue={filters.shortPctChangeMin}
                maxValue={filters.shortPctChangeMax}
                onMinChange={(v) => updateFilter("shortPctChangeMin", v)}
                onMaxChange={(v) => updateFilter("shortPctChangeMax", v)}
                step={0.1}
              />
              <RangeFilterInput
                label="Market Cap ($)"
                minValue={filters.marketCapMin}
                maxValue={filters.marketCapMax}
                onMinChange={(v) => updateFilter("marketCapMin", v)}
                onMaxChange={(v) => updateFilter("marketCapMax", v)}
                placeholder={{ min: "e.g. 100000000", max: "e.g. 5000000000" }}
              />
              <RangeFilterInput
                label="Price Change 1M (%)"
                minValue={filters.priceChange1mMin}
                maxValue={filters.priceChange1mMax}
                onMinChange={(v) => updateFilter("priceChange1mMin", v)}
                onMaxChange={(v) => updateFilter("priceChange1mMax", v)}
                step={1}
              />
              <RangeFilterInput
                label="P/E Ratio"
                minValue={filters.peRatioMin}
                maxValue={filters.peRatioMax}
                onMinChange={(v) => updateFilter("peRatioMin", v)}
                onMaxChange={(v) => updateFilter("peRatioMax", v)}
                step={1}
              />
              <RangeFilterInput
                label="Dividend Yield (%)"
                minValue={filters.dividendYieldMin}
                maxValue={filters.dividendYieldMax}
                onMinChange={(v) => updateFilter("dividendYieldMin", v)}
                onMaxChange={(v) => updateFilter("dividendYieldMax", v)}
                step={0.5}
              />
              <RangeFilterInput
                label="Net Director Buy ($)"
                minValue={filters.netDirectorBuyMin}
                maxValue={filters.netDirectorBuyMax}
                onMinChange={(v) => updateFilter("netDirectorBuyMin", v)}
                onMaxChange={(v) => updateFilter("netDirectorBuyMax", v)}
              />
              <RangeFilterInput
                label="News Sentiment (-1 to 1)"
                minValue={filters.avgSentimentMin}
                maxValue={filters.avgSentimentMax}
                onMinChange={(v) => updateFilter("avgSentimentMin", v)}
                onMaxChange={(v) => updateFilter("avgSentimentMax", v)}
                step={0.1}
              />
              <RangeFilterInput
                label="Days to Cover"
                minValue={filters.daysToCoverMin}
                maxValue={filters.daysToCoverMax}
                onMinChange={(v) => updateFilter("daysToCoverMin", v)}
                onMaxChange={(v) => updateFilter("daysToCoverMax", v)}
                placeholder={{ min: "e.g. 3", max: "e.g. 20" }}
                step={0.5}
              />
            </div>

            <div className="flex flex-wrap items-center gap-4 pt-2 border-t">
              {/* Industry filter */}
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="gap-1.5 text-xs h-8">
                    <Filter className="h-3 w-3" />
                    Industry
                    {filters.industries.length > 0 && (
                      <Badge variant="secondary" className="ml-1 h-4 px-1 text-[10px]">
                        {filters.industries.length}
                      </Badge>
                    )}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-72 p-2 max-h-80 overflow-y-auto" align="start">
                  <div className="space-y-1">
                    {getKnownIndustries().map((industry) => {
                      const checked = filters.industries.some(
                        (i) => i.toLowerCase() === industry.toLowerCase()
                      );
                      return (
                        <label
                          key={industry}
                          className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted cursor-pointer text-xs"
                        >
                          <Checkbox
                            checked={checked}
                            onCheckedChange={(val) => {
                              const updated = val
                                ? [...filters.industries, industry]
                                : filters.industries.filter(
                                    (i) => i.toLowerCase() !== industry.toLowerCase()
                                  );
                              updateFilter("industries", updated);
                            }}
                          />
                          <Image
                            src={getSectorImagePath(industry)}
                            alt=""
                            width={16}
                            height={16}
                            className="rounded-sm flex-shrink-0"
                          />
                          <span className="truncate">{industry}</span>
                        </label>
                      );
                    })}
                  </div>
                  {filters.industries.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="w-full mt-2 text-xs h-7"
                      onClick={() => updateFilter("industries", [])}
                    >
                      Clear all
                    </Button>
                  )}
                </PopoverContent>
              </Popover>

              <div className="flex items-center gap-2">
                <Switch
                  id="director-buys"
                  checked={filters.hasDirectorBuys}
                  onCheckedChange={(checked) =>
                    updateFilter("hasDirectorBuys", !!checked)
                  }
                />
                <Label htmlFor="director-buys" className="text-xs">
                  Has recent director buys
                </Label>
              </div>

              <div className="ml-auto">
                <Button
                  onClick={handleSearch}
                  disabled={isPending}
                  size="sm"
                  className="gap-1.5"
                >
                  <Search className="h-3.5 w-3.5" />
                  {isPending ? "Searching..." : "Search"}
                </Button>
              </div>
            </div>
          </div>
        )}

        {/* Results */}
        {hasSearched && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <p className="text-sm text-muted-foreground">
                  {totalCount.toLocaleString()} stock
                  {totalCount !== 1 ? "s" : ""} found
                </p>
                {results.length > 0 && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-1.5 h-7 text-xs">
                        <Download className="h-3 w-3" />
                        Export
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      <DropdownMenuItem
                        onClick={() => {
                          const rows = screenerRowsToPlain(results);
                          const today = new Date().toISOString().slice(0, 10);
                          downloadCSV(rows, `screener-${today}.csv`, SCREENER_CSV_HEADERS);
                        }}
                      >
                        <Download className="h-3.5 w-3.5 mr-2" />
                        CSV
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          const today = new Date().toISOString().slice(0, 10);
                          downloadJSON(results, `screener-${today}.json`);
                        }}
                      >
                        <FileJson className="h-3.5 w-3.5 mr-2" />
                        JSON
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          const today = new Date().toISOString().slice(0, 10);
                          downloadYAML(results, `screener-${today}.yaml`);
                        }}
                      >
                        <FileText className="h-3.5 w-3.5 mr-2" />
                        YAML
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => window.print()}>
                        <Printer className="h-3.5 w-3.5 mr-2" />
                        Print / PDF
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
              {totalPages > 1 && (
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page === 0 || isPending}
                    onClick={() => handlePageChange(page - 1)}
                  >
                    Previous
                  </Button>
                  <span className="text-sm text-muted-foreground">
                    Page {page + 1} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages - 1 || isPending}
                    onClick={() => handlePageChange(page + 1)}
                  >
                    Next
                  </Button>
                </div>
              )}
            </div>

            <div className="border rounded-lg overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="w-[240px] sticky left-0 bg-background z-10">
                      Stock
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() =>
                          handleSort(ScreenerSortField.SHORT_PCT)
                        }
                        className="inline-flex items-center font-medium hover:text-foreground transition-colors"
                      >
                        Short %
                        <SortIcon field={ScreenerSortField.SHORT_PCT} />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() =>
                          handleSort(ScreenerSortField.DAYS_TO_COVER)
                        }
                        className="inline-flex items-center font-medium hover:text-foreground transition-colors"
                        title="Short positions / avg 20-day volume"
                      >
                        DTC
                        <SortIcon
                          field={ScreenerSortField.DAYS_TO_COVER}
                        />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() =>
                          handleSort(ScreenerSortField.SHORT_PCT_CHANGE)
                        }
                        className="inline-flex items-center font-medium hover:text-foreground transition-colors"
                      >
                        4W Chg
                        <SortIcon
                          field={ScreenerSortField.SHORT_PCT_CHANGE}
                        />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() =>
                          handleSort(ScreenerSortField.PRICE_CHANGE_1M)
                        }
                        className="inline-flex items-center font-medium hover:text-foreground transition-colors"
                      >
                        1M Price
                        <SortIcon
                          field={ScreenerSortField.PRICE_CHANGE_1M}
                        />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() =>
                          handleSort(ScreenerSortField.MARKET_CAP)
                        }
                        className="inline-flex items-center font-medium hover:text-foreground transition-colors"
                      >
                        MCap
                        <SortIcon field={ScreenerSortField.MARKET_CAP} />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() =>
                          handleSort(ScreenerSortField.PE_RATIO)
                        }
                        className="inline-flex items-center font-medium hover:text-foreground transition-colors"
                      >
                        P/E
                        <SortIcon field={ScreenerSortField.PE_RATIO} />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() =>
                          handleSort(ScreenerSortField.DIVIDEND_YIELD)
                        }
                        className="inline-flex items-center font-medium hover:text-foreground transition-colors"
                      >
                        Yield
                        <SortIcon field={ScreenerSortField.DIVIDEND_YIELD} />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() =>
                          handleSort(ScreenerSortField.NET_DIRECTOR_BUY)
                        }
                        className="inline-flex items-center font-medium hover:text-foreground transition-colors"
                      >
                        Dir. Buy
                        <SortIcon
                          field={ScreenerSortField.NET_DIRECTOR_BUY}
                        />
                      </button>
                    </TableHead>
                    <TableHead>
                      <button
                        onClick={() =>
                          handleSort(ScreenerSortField.NEWS_SENTIMENT)
                        }
                        className="inline-flex items-center font-medium hover:text-foreground transition-colors"
                      >
                        Sentiment
                        <SortIcon
                          field={ScreenerSortField.NEWS_SENTIMENT}
                        />
                      </button>
                    </TableHead>
                    <TableHead className="text-right">Industry</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.length === 0 ? (
                    <TableRow>
                      <TableCell
                        colSpan={11}
                        className="text-center py-8 text-muted-foreground"
                      >
                        {isPending
                          ? "Searching..."
                          : "No stocks match your filters. Try adjusting your criteria."}
                      </TableCell>
                    </TableRow>
                  ) : (
                    results.map((stock) => (
                      <TableRow
                        key={stock.stockCode}
                        className="cursor-pointer"
                        onClick={() =>
                          router.push(`/shorts/${stock.stockCode}`)
                        }
                      >
                        <TableCell className="sticky left-0 bg-background z-10">
                          <Link
                            href={`/shorts/${stock.stockCode}`}
                            className="hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <div className="font-medium">
                              {stock.stockCode}
                            </div>
                            <div className="text-xs text-muted-foreground truncate max-w-[220px]">
                              {stock.companyName}
                            </div>
                          </Link>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {stock.shortPct.toFixed(2)}%
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "font-mono text-sm",
                              stock.daysToCover >= 10
                                ? "text-red-500 font-semibold"
                                : stock.daysToCover >= 5
                                  ? "text-orange-500"
                                  : "text-muted-foreground",
                            )}
                            title={`${stock.daysToCover.toFixed(1)} days (avg vol: ${stock.avgVolume20d.toLocaleString()})`}
                          >
                            {stock.daysToCover > 0
                              ? stock.daysToCover.toFixed(1)
                              : "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "font-mono text-sm",
                              stock.shortPctChange4w > 0
                                ? "text-red-500"
                                : stock.shortPctChange4w < 0
                                  ? "text-green-500"
                                  : "text-muted-foreground",
                            )}
                          >
                            {formatPercent(stock.shortPctChange4w)}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "font-mono text-sm",
                              stock.priceChange1m > 0
                                ? "text-green-500"
                                : stock.priceChange1m < 0
                                  ? "text-red-500"
                                  : "text-muted-foreground",
                            )}
                          >
                            {formatPercent(stock.priceChange1m)}
                          </span>
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {stock.marketCap > 0
                            ? `$${formatMarketCap(stock.marketCap)}`
                            : "-"}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {stock.peRatio > 0
                            ? stock.peRatio.toFixed(1)
                            : "-"}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {stock.dividendYield > 0
                            ? `${stock.dividendYield.toFixed(2)}%`
                            : "-"}
                        </TableCell>
                        <TableCell>
                          <span
                            className={cn(
                              "font-mono text-sm",
                              stock.netDirectorBuyValue > 0
                                ? "text-green-500"
                                : stock.netDirectorBuyValue < 0
                                  ? "text-red-500"
                                  : "text-muted-foreground",
                            )}
                          >
                            {stock.netDirectorBuyValue !== 0
                              ? formatDollars(stock.netDirectorBuyValue)
                              : "-"}
                          </span>
                        </TableCell>
                        <TableCell>
                          {stock.newsCount30d > 0 ? (
                            <span
                              className={cn(
                                "text-xs font-medium px-1.5 py-0.5 rounded",
                                stock.avgSentiment > 0.2
                                  ? "bg-green-500/10 text-green-500"
                                  : stock.avgSentiment < -0.2
                                    ? "bg-red-500/10 text-red-500"
                                    : "bg-muted text-muted-foreground",
                              )}
                            >
                              {stock.avgSentiment > 0 ? "+" : ""}
                              {stock.avgSentiment.toFixed(2)}
                            </span>
                          ) : (
                            <span className="text-muted-foreground text-sm">
                              -
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground max-w-[150px]">
                          <span className="inline-flex items-center gap-1.5 justify-end">
                            {stock.industry ? (
                              <>
                                <Image
                                  src={getSectorImagePath(stock.industry)}
                                  alt=""
                                  width={14}
                                  height={14}
                                  className="rounded-sm flex-shrink-0"
                                />
                                <span className="truncate">{stock.industry}</span>
                              </>
                            ) : (
                              "-"
                            )}
                          </span>
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>

            {/* Bottom pagination */}
            {totalPages > 1 && (
              <div className="flex items-center justify-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page === 0 || isPending}
                  onClick={() => handlePageChange(page - 1)}
                >
                  Previous
                </Button>
                <span className="text-sm text-muted-foreground">
                  Page {page + 1} of {totalPages}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages - 1 || isPending}
                  onClick={() => handlePageChange(page + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </div>
        )}

        {/* Initial state - show instructions */}
        {!hasSearched && (
          <div className="border rounded-lg p-8 text-center space-y-3 bg-muted/10">
            <Search className="h-10 w-10 mx-auto text-muted-foreground/50" />
            <h3 className="text-lg font-medium">
              Start screening ASX stocks
            </h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              Choose a preset above for quick insights, or set custom filters
              and click Search. Results combine short positions, price data,
              fundamentals, director trades, and news sentiment.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
